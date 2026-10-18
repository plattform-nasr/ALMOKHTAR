/* =========================================================
   Math Center Platform — Shared Core
   Data layer backed by Firebase Realtime Database (see
   firebase.js, which must be loaded before this file). This
   file never touches the Firebase SDK directly — it only
   reads window._mcCache and writes through window._mc.
   ========================================================= */

var DB_KEYS = { SESSION: 'mc_session_v1' }; // session (who's logged in on THIS device) stays local on purpose[cite: 12]

/* ---------------- generic storage helpers (session/theme/lang only) ---------------- */
function mcRead(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) { return fallback; }
}
function mcWrite(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

window.getSettings = function () {
  return window._mcCache.settings;
};
window.saveSettings = function (settings) {
  return window._mc.set(window._mc.ref(window._mc.db, 'settings'), settings);
};

/* ---------------- students ---------------- */
window.listenToStudents = function (cb) {
  cb(window.getStudents());
  window.onMCUpdate('students', function () { cb(window.getStudents()); });
};
window.getStudents = function () { return window._mcCache.students || []; };

window.saveStudent = function (student) {
  if (!student.id) {
    var newRef = window._mc.push(window._mc.ref(window._mc.db, 'students'));
    student.id = newRef.key;
    student.createdAt = new Date().toISOString();
    student.paid = false;
    window._mc.set(newRef, student);
  } else {
    window._mc.set(window._mc.ref(window._mc.db, 'students/' + student.id), student);
  }
  var cachedStudent = window._mcCache.students.find(function (item) { return item.id === student.id; });
  if (cachedStudent) Object.keys(student).forEach(function (key) { cachedStudent[key] = student[key]; });
  else window._mcCache.students.push(student);
  return student;
};
window.findStudentByPhone = function (phone, classId) {
  var list = window.getStudents();
  return list.find(function (s) {
    return s.phone === phone && (!classId || s.classId === classId);
  }) || null;
};
window.verifyStudentPassword = function (student, password) {
  return !!student && !!password && student.password === password;
};
window.getStudentById = function (id) {
  var list = window.getStudents();
  return list.find(function (s) { return s.id === id; }) || null;
};
window.getDeviceId = function () {
  var key = 'mc_device_id';
  var id = localStorage.getItem(key);
  if (!id) { id = 'device-' + Math.random().toString(36).slice(2) + Date.now(); localStorage.setItem(key, id); }
  return id;
};

/* ---------------- multi-device session enforcement (max 2 devices per account) ---------------- */
window.MC_MAX_DEVICES = 2; // fallback used for students, and for admin before settings.maxAdminDevices is ever set

// Admin's own device-count limit is configurable from the settings screen
// (settings.maxAdminDevices). Falls back to MC_MAX_DEVICES when unset/invalid.
window.getMaxAdminDevices = function () {
  var settings = window.getSettings ? window.getSettings() : null;
  var n = settings && parseInt(settings.maxAdminDevices, 10);
  if (!n || n < 1) n = window.MC_MAX_DEVICES;
  return n;
};

// Normalizes an owner's (student or admin) active sessions into a
// { deviceId: lastSeenTimestamp } map, folding in the old single-device
// fields (activeSessionId/activeSessionAt) so existing accounts migrate
// smoothly instead of suddenly losing their one currently-logged-in device.
window.getActiveDeviceSessions = function (owner) {
  var sessions = {};
  if (owner && owner.activeSessions && typeof owner.activeSessions === 'object') {
    Object.keys(owner.activeSessions).forEach(function (k) { sessions[k] = owner.activeSessions[k]; });
  }
  if (owner && owner.activeSessionId) {
    sessions[owner.activeSessionId] = owner.activeSessionAt || Date.now();
  }
  return sessions;
};

// A device may log in if it already holds one of the slots, or if there is
// a free slot (fewer than maxDevices devices currently active). maxDevices
// is optional and defaults to MC_MAX_DEVICES (used for students; admin
// login passes window.getMaxAdminDevices() so it can be configured).
window.MC_MAX_STUDENT_DEVICES = 5; // 0 = unlimited devices per student account (set a number like 2 to bring the limit back)
window.canDeviceLogin = function (sessions, deviceId, maxDevices) {
  // Students call this without maxDevices -> no device limit for them.
  // Admin login passes an explicit maxDevices, so the admin limit still applies.
  if (maxDevices === undefined || maxDevices === null) {
    if (!window.MC_MAX_STUDENT_DEVICES || window.MC_MAX_STUDENT_DEVICES < 1) return true;
    maxDevices = window.MC_MAX_STUDENT_DEVICES;
  }
  var ids = Object.keys(sessions || {});
  if (ids.indexOf(deviceId) !== -1) return true;
  return ids.length < maxDevices;
};

window.updateStudentSession = function (studentId, deviceId) {
  var student = window.getStudentById(studentId);
  var sessions = window.getActiveDeviceSessions(student);
  sessions[deviceId] = Date.now();
  return window._mc.update(window._mc.ref(window._mc.db, 'students/' + studentId), {
    activeSessions: sessions,
    activeSessionId: null,
    activeSessionAt: null
  });
};

window.updateAdminSession = function (deviceId) {
  var settings = window.getSettings() || {};
  var sessions = window.getActiveDeviceSessions({ activeSessions: settings.adminSessions });
  sessions[deviceId] = Date.now();
  settings.adminSessions = sessions;
  window.saveSettings(settings);
  return sessions;
};

// Keeps a logged-in admin tab honest in real time: whenever settings changes
// (e.g. another device/tab hits "log out other admin devices"), check
// whether this device is still in settings.adminSessions. If it's been
// dropped, clear the local session and send this tab back to the login
// page immediately — no need to wait for a refresh.
// onKicked (optional) lets the caller show a toast/message before redirecting.
window.startAdminSessionGuard = function (onKicked) {
  var deviceId = window.getDeviceId();
  function check() {
    var settings = window.getSettings() || {};
    var sessions = window.getActiveDeviceSessions({ activeSessions: settings.adminSessions });
    var ids = Object.keys(sessions);
    // Only act once we actually have a recorded session list — an empty/
    // unset adminSessions just means nobody has logged in yet and must not
    // be treated as "this device got kicked".
    if (ids.length > 0 && ids.indexOf(deviceId) === -1) {
      window.clearSession();
      if (typeof onKicked === 'function') {
        onKicked();
      } else {
        window.location.replace('index.html');
      }
    }
  }
  window.onMCUpdate('settings', check);
  check();
};
window.togglePaid = function (studentId) {
  var list = window.getStudents();
  var s = list.find(function (x) { return x.id === studentId; });
  if (!s) return null;
  var newVal = !s.paid;
  window._mc.update(window._mc.ref(window._mc.db, 'students/' + studentId), { paid: newVal });
  s.paid = newVal; // optimistic local update; the live listener will confirm it
  return s;
};

/* ---------------- dates ---------------- */
// new Date().toISOString() reports the date in UTC. In a timezone ahead
// of UTC (like Egypt, UTC+2/+3), that means for the first couple of
// hours after local midnight, toISOString() still reports YESTERDAY's
// date — so a record saved right after local midnight, or a same-day
// check run shortly after, disagreed with what the calendar actually
// showed the admin. This builds the date string from local calendar
// fields instead, so it always matches the admin's own clock.
window.localDateStr = function (d) {
  d = d || new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
};

/* ---------------- attendance ---------------- */
window.getAttendance = function () { return window._mcCache.attendance || []; };

window.markAttendance = function (studentId, status, dateStr, details) {
  var date = dateStr || window.localDateStr();
  var list = window.getAttendance();
  var existing = list.find(function (a) { return a.studentId === studentId && a.date === date; });
  if (existing) {
    window._mc.update(window._mc.ref(window._mc.db, 'attendance/' + existing.id), { status: status, details: details || [] });
    existing.status = status;
    existing.details = details || [];
    return existing;
  }
  var newRef = window._mc.push(window._mc.ref(window._mc.db, 'attendance'));
  var record = { id: newRef.key, studentId: studentId, date: date, status: status, details: details || [] };
  window._mc.set(newRef, record);
  return record;
};

window.getAttendanceForStudent = function (studentId) {
  return window.getAttendance().filter(function (a) { return a.studentId === studentId; })
    .sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
};

window.markAttendanceMessageSent = function (attendanceId) {
  var record = window.getAttendance().find(function (a) { return a.id === attendanceId; });
  if (!record) return;
  window._mc.update(window._mc.ref(window._mc.db, 'attendance/' + attendanceId), { messageSent: true });
  record.messageSent = true;
};

window.getAttendanceStats = function (studentId) {
  var records = window.getAttendanceForStudent(studentId);
  var present = records.filter(function (r) { return r.status === 'present'; }).length;
  var absent = records.filter(function (r) { return r.status === 'absent'; }).length;
  var total = present + absent;
  var pct = total ? Math.round((present / total) * 100) : 0;
  return { present: present, absent: absent, total: total, pct: pct };
};

/* ---------------- grades ---------------- */
window.getGrades = function () { return window._mcCache.grades || []; };

window.saveGrade = function (grade) {
  var newRef = window._mc.push(window._mc.ref(window._mc.db, 'grades'));
  grade.id = newRef.key;
  grade.date = grade.date || new Date().toISOString().slice(0, 10);
  grade.createdAt = new Date().toISOString();
  window._mc.set(newRef, grade);
  return grade;
};

window.deleteGrade = function (gradeId) {
  return window._mc.remove(window._mc.ref(window._mc.db, 'grades/' + gradeId));
};

/* ---------------- homework, notes and notifications ---------------- */
function saveCollectionItem(collection, item) {
  var newRef = window._mc.push(window._mc.ref(window._mc.db, collection));
  item.id = newRef.key;
  item.createdAt = new Date().toISOString();
  if (Array.isArray(window._mcCache[collection])) window._mcCache[collection].push(item);
  return window._mc.set(newRef, item).then(function () { return item; });
}
window.getHomework = function () { return window._mcCache.homework || []; };
window.getNotes = function () { return window._mcCache.notes || []; };
window.getNotifications = function (studentId) {
  return (window._mcCache.notifications || []).filter(function (n) { return !n.studentId || n.studentId === studentId; });
};
window.saveHomework = function (item) { return saveCollectionItem('homework', item); };
window.saveNote = function (item) { return saveCollectionItem('notes', item); };
window.saveNotification = function (item) { return saveCollectionItem('notifications', item); };
window.deleteStudent = function (studentId) {
  var db = window._mc.db, ref = window._mc.ref, remove = window._mc.remove;
  var related = {};
  window.getAttendance().forEach(function (a) { if (a.studentId === studentId) related['attendance/' + a.id] = null; });
  window.getGrades().forEach(function (g) { if (g.studentId === studentId) related['grades/' + g.id] = null; });
  window.getNotes().forEach(function (n) { if (n.studentId === studentId) related['notes/' + n.id] = null; });
  window.getNotifications(studentId).forEach(function (n) { if (n.studentId === studentId) related['notifications/' + n.id] = null; });
  var writes = [remove(ref(db, 'students/' + studentId))];
  Object.keys(related).forEach(function (path) { writes.push(remove(ref(db, path))); });
  return Promise.all(writes);
};

window.getGradesForStudent = function (studentId) {
  return window.getGrades().filter(function (g) { return g.studentId === studentId; })
    .sort(function (a, b) {
      // Newest first: compare by date, then break ties on the Firebase push
      // key (which is itself chronological), so grades entered the same day
      // still come out in true creation order instead of insertion order.
      var byDate = (b.date || '').localeCompare(a.date || '');
      if (byDate !== 0) return byDate;
      return (b.id || '').localeCompare(a.id || '');
    });
};

// Overall percentage = total points earned / total points possible across
// every recorded exam (not a simple average of per-exam percentages), which
// is what "النسبة المئوية العامة" (the general/overall percentage) means.
window.getGradeStats = function (studentId) {
  var records = window.getGradesForStudent(studentId);
  var totalScore = 0, totalMax = 0;
  records.forEach(function (r) {
    totalScore += Number(r.score) || 0;
    totalMax += Number(r.maxScore) || 0;
  });
  var pct = totalMax ? Math.round((totalScore / totalMax) * 100) : 0;
  var avgScore = records.length ? Math.round((totalScore / records.length) * 10) / 10 : 0;
  return { count: records.length, totalScore: totalScore, totalMax: totalMax, pct: pct, avgScore: avgScore };
};

/* ---------------- promotion / new academic year ---------------- */
// End-of-year promotion: moves every student up into the next class in
// settings.classes order (e.g. الأول الإعدادي → الثاني الإعدادي → الثالث
// الإعدادي → الأول الثانوي → الثاني الثانوي → الثالث الثانوي), keeping
// each student's attendance/grades/notes history intact — only classId
// changes. Students already in the LAST class graduate: since there's no
// class left to promote them into, their student record and every related
// attendance/grade/note/notification record are permanently deleted.
// Platform settings/centers/classes themselves are never touched.
window.promoteAllStudents = function () {
  var db = window._mc.db, ref = window._mc.ref, update = window._mc.update;
  var classes = (window.getSettings() || {}).classes || [];
  if (classes.length < 2) return Promise.resolve();

  var nextClassId = {};
  for (var i = 0; i < classes.length - 1; i++) nextClassId[classes[i].id] = classes[i + 1].id;
  var lastClassId = classes[classes.length - 1].id;

  var graduating = {};
  var updates = {};
  window.getStudents().forEach(function (s) {
    if (s.classId === lastClassId) {
      graduating[s.id] = true;
      updates['students/' + s.id] = null;
    } else if (nextClassId[s.classId]) {
      updates['students/' + s.id + '/classId'] = nextClassId[s.classId];
    }
    // a student whose classId doesn't match any known class is left as-is
  });

  window.getAttendance().forEach(function (a) { if (graduating[a.studentId]) updates['attendance/' + a.id] = null; });
  window.getGrades().forEach(function (g) { if (graduating[g.studentId]) updates['grades/' + g.id] = null; });
  window.getNotes().forEach(function (n) { if (graduating[n.studentId]) updates['notes/' + n.id] = null; });
  (window._mcCache.notifications || []).forEach(function (n) { if (n.studentId && graduating[n.studentId]) updates['notifications/' + n.id] = null; });

  return update(ref(db), updates);
};

/* ---------------- reset / new-cycle ---------------- */
// Wipes students, attendance and grades (keeps platform settings/centers/classes intact)
// so the admin can start a fresh term/year without reconfiguring the platform.
window.resetAllData = function () {
  var db = window._mc.db, ref = window._mc.ref, remove = window._mc.remove;
  return Promise.all([
    remove(ref(db, 'students')),
    remove(ref(db, 'attendance')),
    remove(ref(db, 'grades')),
    remove(ref(db, 'homework'))
  ]);
};

/* ---------------- leaderboard ---------------- */
// Ranks students by a combined score: overall grade percentage + attendance
// percentage (each out of 100, so the score tops out at 200). Sorted best-first.
// filters: { classId, center } — both optional, used to scope the ranking
// (e.g. a single class for the student-facing page, or class+center for the
// admin dashboard filters).
window.getLeaderboard = function (filters) {
  filters = filters || {};
  return window.getStudents()
    .filter(function (s) {
      if (filters.classId && s.classId !== filters.classId) return false;
      if (filters.center && s.center !== filters.center) return false;
      return true;
    })
    .map(function (s) {
      var gradeStats = window.getGradeStats(s.id);
      var attendanceStats = window.getAttendanceStats(s.id);
      return {
        student: s,
        points: gradeStats.pct + attendanceStats.pct,
        gradePct: gradeStats.pct,
        attendancePct: attendanceStats.pct
      };
    })
    .sort(function (a, b) { return b.points - a.points; });
};
// Convenience wrapper for the student-facing page: ranking within one class only.
window.getLeaderboardForClass = function (classId) {
  return window.getLeaderboard({ classId: classId });
};

/* ---------------- i18n ---------------- */
var MC_DICT = {
  ar: {
    appName: 'سنتر الرياضيات', loginTitle: 'تسجيل الدخول', enterCode: 'من فضلك أدخل الكود',
    codePlaceholder: 'أدخل كود الأدمن أو كود الصف', continueBtn: 'متابعة', invalidCode: 'الكود غير صحيح، حاول مرة أخرى',
    registeredStudent: 'طالب مسجل', newStudent: 'طالب جديد', parentPhone: 'رقم هاتف ولي الأمر',
    parentTelegram: 'تيليجرام ولي الأمر (لإرسال الرسائل تلقائياً)', fetchTelegramChats: 'جلب المحادثات',
    telegramPickerTitle: 'اختر محادثة تيليجرام',
    telegramPickerHint: 'تظهر هنا فقط المحادثات اللي بعتت أي رسالة للبوت قبل كده (لازم ولي الأمر يضغط Start على البوت الأول).',
    searchAccount: 'ابحث عن الحساب', noAccountFound: 'لا يوجد حساب بهذا الرقم في هذا الصف',
    studentName: 'اسم الطالب', chooseCenter: 'اختر السنتر', uploadAvatar: 'رفع صورة شخصية',
    saveAndContinue: 'حفظ ومتابعة', selectedClass: 'الصف الدراسي المختار',
    adminTitle: 'لوحة تحكم الأستاذ', mainSection: 'الرئيسية', prepSection: 'التجهيز', center: 'السنتر', classLevel: 'الصف الدراسي',
    showList: 'عرض القائمة', addStudent: 'إضافة طالب جديد', fullRecord: 'السجل الشامل',
    attendanceTable: 'قائمة الحضور', paid: 'مدفوع', unpaid: 'غير مدفوع', present: 'حاضر', absent: 'غائب',
    noStudentsYet: 'لا يوجد طلاب في هذه المجموعة بعد', filterByName: 'فلترة بالاسم',
    filterByPhone: 'رقم الهاتف', allCenters: 'كل السناتر', allClasses: 'كل الصفوف',
    settings: 'إعدادات المنصة', changeAdminPassword: 'تغيير كلمة مرور الأدمن', changeClassCodes: 'تغيير أكواد الصفوف',
    platformName: 'اسم المنصة', platformLogo: 'شعار المنصة', save: 'حفظ', cancel: 'إلغاء',
    studentPage: 'صفحة الطالب', attendanceRate: 'نسبة الحضور', absenceCount: 'عدد مرات الغياب',
    monthlyRecord: 'سجل الحضور الشهري', mathAssistant: 'مساعد الرياضيات الذكي', askMathQuestion: 'اسأل سؤالاً في الرياضيات...',
    send: 'إرسال', logout: 'خروج', close: 'إغلاق', edit: 'تعديل', delete: 'حذف',
    logoutConfirmMsg: 'هل أنت متأكد أنك تريد تسجيل الخروج؟',
    sessionsCount: 'عدد الحصص', totalSessions: 'إجمالي الحصص',
    whatsappSent: 'تم تسجيل الحالة وفتح واتساب', paidUpdated: 'تم تحديث حالة الدفع',
    settingsSaved: 'تم حفظ الإعدادات', studentSaved: 'تم حفظ بيانات الطالب',
    wrongPassword: 'كلمة المرور غير صحيحة', required: 'هذا الحقل مطلوب',
    months: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
    noRecordsYet: 'لا يوجد سجل حضور بعد', backToAdmin: 'رجوع', themeToggle: 'الوضع الليلي/النهاري',
    langToggle: 'EN', adminLogin: 'دخول الأستاذ', chatbotGreeting: 'أهلاً! اسألني أي سؤال في الرياضيات وهساعدك خطوة بخطوة.',
    chatbotThinking: 'بيفكر...', selectCenterFirst: 'اختر السنتر والصف أولاً', totalStudents: 'عدد الطلاب',
    paidCount: 'دفعوا', unpaidCount: 'لم يدفعوا',
    gradesSection: 'الدرجات', addGrade: 'إضافة درجة', selectStudent: 'اختر الطالب', homeworkFileLabel: 'ملف PDF أو صورة', chooseFile: 'اختيار ملف', noFileChosen: 'لم يتم اختيار ملف',
    examName: 'اسم الاختبار', scoreObtained: 'الدرجة المحصلة', scoreOutOf: 'الدرجة الكاملة',
    gradeSaved: 'تم حفظ الدرجة', gradesList: 'سجل الدرجات', noGradesYet: 'لا يوجد درجات مسجلة بعد',
    overallPercentage: 'النسبة المئوية العامة', averageScore: 'متوسط الدرجة', examsCount: 'عدد الاختبارات',
    examDate: 'التاريخ', chooseStudentFirst: 'اختر طالباً أولاً', deleteGradeConfirm: 'هل تريد حذف هذه الدرجة؟',
    gradeDeleted: 'تم حذف الدرجة', tapToToggle: 'اضغط للتبديل', outOf: 'من',
    studentPassword: 'كلمة المرور', createPassword: 'إنشاء كلمة مرور', confirmPassword: 'تأكيد كلمة المرور',
    passwordMismatch: 'كلمتا المرور غير متطابقتين',
    dangerZone: 'منطقة خطرة', resetData: 'ترقية الطلاب + حذف المتخرجين نهائياً', resetDataDesc: 'نقل كل طالب للصف اللي بعده مباشرة (مثلاً الأول الإعدادي يبقى الثاني الإعدادي وهكذا لكل الصفوف) مع الاحتفاظ بسجل حضوره ودرجاته، وحذف بيانات طلاب آخر صف نهائياً لأنهم اتخرجوا (لن يتأثر اسم المنصة أو السناتر أو الصفوف)',
    resetDataConfirm: 'هيتم نقل كل طالب للصف اللي بعده، وحذف بيانات طلاب آخر صف نهائياً لأنهم اتخرجوا. هذا الإجراء لا يمكن التراجع عنه. هل أنت متأكد من المتابعة؟',
    resetDataConfirm2: 'تأكيد أخير: هل تريد فعلاً ترقية كل الطلاب الآن؟ لا يمكن التراجع بعد ذلك.',
    resetDataDone: 'تم ترقية جميع الطلاب بنجاح',
    leaderboard: 'لوحة الصدارة', leaderboardDesc: 'الترتيب داخل صفك بناءً على الدرجات والحضور',
    leaderboardEmpty: 'لا يوجد بيانات كافية لعرض الترتيب بعد', points: 'نقطة', you: 'أنت',
    myAccount: 'بيانات حسابي', classCodeLabel: 'كود الصف الدراسي', yourRank: 'ترتيبك في لوحة الصدارة',
    yourPoints: 'نقاطك', accountTypeTitle: 'النوع',
    accountTypeHint: 'اختار نوعك مرة واحدة بس — هيتم استخدامه لاحقاً في حجوزات الكورة',
    accountTypeLockedPrefix: 'النوع المسجل:', genderMale: 'ذكر', genderFemale: 'أنثى',
    genderConfirmMsg: 'هتقدر تحدد النوع مرة واحدة بس ومش هتقدر تغيّره تاني بعد كده. متأكد؟',
    confirmBtn: 'تأكيد', genderSaved: 'تم حفظ النوع بنجاح',
    appearanceTitle: 'المظهر', themeColorLabel: 'لون السمة',
    themeColorHint: 'اختار لون السمة الخاص بصفحتك بس — مش هيأثر على باقي المستخدمين',
    useDefaultThemeColor: 'استخدام لون المنصة الافتراضي', themeColorSaved: 'تم حفظ لون السمة',
    themeColorReset: 'تم الرجوع للون الافتراضي',
    pageBackgroundLabel: 'خلفية صفحتك', pageBackgroundHint: 'ارفع صورة تحبها كخلفية لصفحتك أنت بس',
    chooseBackgroundImage: 'اختيار صورة', removeBackgroundImage: 'إزالة الخلفية',
    backgroundSaved: 'تم حفظ الخلفية', backgroundRemoved: 'تم إزالة الخلفية',
    couldNotReadImage: 'تعذر قراءة هذه الصورة، جرّب صورة تانية.',
    loading: 'جاري التحميل...', welcomeToPlatform: 'أهلاً بيك في مركز الرياضيات',
    homeworkNav: 'الواجبات', allHomework: 'كل الواجبات', notesLog: 'سجل الملاحظات',
    menuTitle: 'القائمة', notesNav: 'الملاحظات', gameLabel: 'لعبة', comingSoon: 'قريباً',
    newsLabel: 'الإعلانات والأخبار', footballBookingLabel: 'حجوزات كورة', todoList: 'قائمة المهام',
    addLabel: 'إضافة', typeNewTask: 'اكتب مهمة جديدة...', calculatorLabel: 'آلة حاسبة علمية',
    myNotesLabel: 'ملاحظاتي', myNotesDesc: 'دوّن أي ملاحظة تحب ترجع لها بعدين، زي وقت الحصة مثلاً',
    typeNewNote: 'اكتب ملاحظة...', noMyNotesYet: 'لا يوجد ملاحظات مسجلة بعد',
    streakLabel: 'الاستمرارية', streakDesc: 'عدد الحصص المتتالية اللي حضرتها من غير غياب',
    currentStreak: 'سلسلتك الحالية', bestStreak: 'أطول سلسلة حضور',
    badgesLabel: 'الشارات', badgesDesc: 'شارات بتتفتح تلقائي كل ما تحقق إنجاز جديد',
    attendanceBadgesTitle: 'شارات الحضور', gradesBadgesTitle: 'شارات الدرجات الكاملة',
    sessionsUnit: 'حصة', fullGradeUnit: 'درجة كاملة',
    attendanceBadgeBronze: 'حضور مستمر', attendanceBadgeSilver: 'حضور مميز',
    attendanceBadgeGold: 'حضور ذهبي', attendanceBadgeDiamond: 'حضور أسطوري',
    gradesBadgeBronze: 'أول تفوق', gradesBadgeSilver: 'متفوق',
    gradesBadgeGold: 'نجم متألق', gradesBadgeDiamond: 'عبقري الرياضيات',
    tapToShareBadge: 'اضغط للمشاركة', shareBadgeAria: 'مشاركة الشارة',
    confirmDownloadBadge: 'هل تريد تحميل هذه الشارة كصورة؟', downloadImageBtn: 'تحميل الصورة',
    subscriptionStatusLabel: 'حالة الاشتراك',
    contactUs: 'تواصل معانا', facebookLabel: 'فيسبوك', facebookHint: 'تابعنا على فيسبوك',
    instagramLabel: 'إنستجرام', instagramHint: 'تابعنا على إنستجرام',
    whatsappLabel: 'واتساب', whatsappHint: 'راسلنا على واتساب',
    telegramLabel: 'تليجرام', telegramHint: 'راسلنا على بوت التليجرام',
    notificationsTitle: 'الإشعارات', noteDetailTitle: 'الملاحظة',
    noTasksYet: 'لا توجد مهام بعد', noHomeworkYet: 'لا توجد واجبات جديدة',
    noteFromTeacher: 'ملاحظة من الأستاذ', noNotesYet: 'لا توجد ملاحظات',
    noNotificationsYet: 'لا توجد إشعارات جديدة', openFile: 'فتح الملف', downloadFile: 'تحميل الملف',
    homeworkNotesTab: 'الواجبات والملاحظات', unpaidAllPaid: 'تم الدفع من كل الطلاب',
    unpaidStudentsTitle: 'الطلاب الغير دافعين', uploadHomeworkTitle: 'رفع واجب',
    homeworkTitleField: 'عنوان الواجب', centerAndClassField: 'السنتر والصف', saveHomeworkBtn: 'حفظ الواجب',
    sendNoteTitle: 'إرسال ملاحظة', searchByStudentName: 'ابحث باسم الطالب',
    chooseStudentToSearchBtn: 'اختر طالباً للبحث', targetField: 'المستهدف', allStudentsBtn: 'كل الطلاب',
    writeNotePh: 'اكتب الملاحظة', sendNoteBtn: 'إرسال الملاحظة', attendanceTabLabel: 'الحضور والغياب',
    deleteStudentPermanently: 'حذف الطالب نهائياً', resetConfirmTitle: 'تأكيد ترقية الطلاب',
    confirmTitle: 'تأكيد', confirmDeleteBtn: 'تأكيد الحذف', sendAbsenceMessagesTitle: 'إرسال رسائل الحضور',
    absenceQueueHint: 'دوس "إرسال" جنب كل طالب لوحده (غايب أو حاضر). هيفتح واتساب برسالته جاهزة، ابعتها وارجع تاني هنا للطالب اللي بعده.',
    chooseStudentTitle: 'اختيار الطالب', chooseStudentForNoteTitle: 'اختيار طالب للملاحظة',
    chooseNoteTargetTitle: 'اختيار مستهدف الملاحظة', chooseCenterTitle: 'اختيار السنتر',
    noMatchingStudent: 'لا يوجد طالب مطابق', typeStudentNameToSearch: 'اكتب اسم الطالب للبحث',
    noCentersYet: 'لا يوجد سناتر بعد'
  },
  en: {
    appName: 'Math Center', loginTitle: 'Sign in', enterCode: 'Please enter your code',
    codePlaceholder: 'Enter admin code or class code', continueBtn: 'Continue', invalidCode: 'Invalid code, try again',
    registeredStudent: 'Registered student', newStudent: 'New student', parentPhone: "Parent's phone number",
    parentTelegram: "Parent's Telegram (for automatic messages)", fetchTelegramChats: 'Fetch chats',
    telegramPickerTitle: 'Choose a Telegram chat',
    telegramPickerHint: 'Only chats that have already messaged the bot show up here (the parent needs to press Start on the bot first).',
    searchAccount: 'Find my account', noAccountFound: 'No account found with this number in this class',
    studentName: 'Student name', chooseCenter: 'Choose center', uploadAvatar: 'Upload photo',
    saveAndContinue: 'Save & continue', selectedClass: 'Selected class',
    adminTitle: 'Teacher dashboard', mainSection: 'Home', prepSection: 'Setup', center: 'Center', classLevel: 'Class',
    showList: 'Show list', addStudent: 'Add new student', fullRecord: 'Full record',
    attendanceTable: 'Attendance list', paid: 'Paid', unpaid: 'Unpaid', present: 'Present', absent: 'Absent',
    noStudentsYet: 'No students in this group yet', filterByName: 'Filter by name',
    filterByPhone: 'Phone number', allCenters: 'All centers', allClasses: 'All classes',
    settings: 'Platform settings', changeAdminPassword: 'Change admin password', changeClassCodes: 'Change class codes',
    platformName: 'Platform name', platformLogo: 'Platform logo', save: 'Save', cancel: 'Cancel',
    studentPage: 'Student page', attendanceRate: 'Attendance rate', absenceCount: 'Absences',
    monthlyRecord: 'Monthly attendance', mathAssistant: 'Math AI assistant', askMathQuestion: 'Ask a math question...',
    send: 'Send', logout: 'Log out', close: 'Close', edit: 'Edit', delete: 'Delete',
    logoutConfirmMsg: 'Are you sure you want to log out?',
    sessionsCount: 'Sessions', totalSessions: 'Total sessions',
    whatsappSent: 'Status recorded, opening WhatsApp', paidUpdated: 'Payment status updated',
    settingsSaved: 'Settings saved', studentSaved: 'Student saved',
    wrongPassword: 'Incorrect password', required: 'This field is required',
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    noRecordsYet: 'No attendance yet', backToAdmin: 'Back', themeToggle: 'Toggle theme',
    langToggle: 'AR', adminLogin: 'Teacher sign in', chatbotGreeting: "Hi! Ask me any math question and I'll walk you through it.",
    chatbotThinking: 'Thinking...', selectCenterFirst: 'Choose a center and class first', totalStudents: 'Students',
    paidCount: 'Paid', unpaidCount: 'Unpaid',
    gradesSection: 'Grades', addGrade: 'Add grade', selectStudent: 'Select student', homeworkFileLabel: 'PDF or image file', chooseFile: 'Choose file', noFileChosen: 'No file selected',
    examName: 'Exam name', scoreObtained: 'Score obtained', scoreOutOf: 'Out of',
    gradeSaved: 'Grade saved', gradesList: 'Grades record', noGradesYet: 'No grades recorded yet',
    overallPercentage: 'Overall percentage', averageScore: 'Average score', examsCount: 'Exams',
    examDate: 'Date', chooseStudentFirst: 'Choose a student first', deleteGradeConfirm: 'Delete this grade?',
    gradeDeleted: 'Grade deleted', tapToToggle: 'Tap to toggle', outOf: 'of',
    studentPassword: 'Password', createPassword: 'Create password', confirmPassword: 'Confirm password',
    passwordMismatch: 'Passwords do not match',
    dangerZone: 'Danger zone', resetData: 'Promote Students + Delete Graduates', resetDataDesc: "Moves every student up into their next class (e.g. Prep 1 becomes Prep 2, and so on for every class), keeping their attendance and grades history — students already in the final class graduate and have their data permanently deleted (platform name, centers and classes are kept)",
    resetDataConfirm: 'This will move every student up to their next class, and permanently delete the data of students in the final class (they graduate). This action cannot be undone. Are you sure you want to continue?',
    resetDataConfirm2: 'Final confirmation: do you really want to promote all students now? This cannot be undone.',
    resetDataDone: 'All students were promoted successfully',
    leaderboard: 'Leaderboard', leaderboardDesc: 'Ranking within your class, based on grades and attendance',
    leaderboardEmpty: 'Not enough data yet to show a ranking', points: 'pts', you: 'you',
    myAccount: 'My Account', classCodeLabel: 'Class code', yourRank: 'Your leaderboard rank',
    yourPoints: 'Your points', accountTypeTitle: 'Type',
    accountTypeHint: 'Pick your type once — it will be used later for football-court bookings',
    accountTypeLockedPrefix: 'Registered type:', genderMale: 'Male', genderFemale: 'Female',
    genderConfirmMsg: "You can set this only once and won't be able to change it afterwards. Are you sure?",
    confirmBtn: 'Confirm', genderSaved: 'Type saved successfully',
    appearanceTitle: 'Appearance', themeColorLabel: 'Theme color',
    themeColorHint: "Pick a theme color just for your own page — it won't affect other users",
    useDefaultThemeColor: 'Use platform default color', themeColorSaved: 'Theme color saved',
    themeColorReset: 'Reverted to the default color',
    pageBackgroundLabel: 'Your page background', pageBackgroundHint: 'Upload an image to use as the background of your own page only',
    chooseBackgroundImage: 'Choose image', removeBackgroundImage: 'Remove background',
    backgroundSaved: 'Background saved', backgroundRemoved: 'Background removed',
    couldNotReadImage: "Couldn't read this image, try another one.",
    loading: 'Loading...', welcomeToPlatform: 'Welcome to the Math Center',
    homeworkNav: 'Homework', allHomework: 'All homework', notesLog: 'Notes log',
    menuTitle: 'Menu', notesNav: 'Notes', gameLabel: 'Game', comingSoon: 'Coming soon',
    newsLabel: 'News & announcements', footballBookingLabel: 'Football bookings', todoList: 'To-do list',
    addLabel: 'Add', typeNewTask: 'Type a new task...', calculatorLabel: 'Scientific calculator',
    myNotesLabel: 'My Notes', myNotesDesc: 'Jot down anything you want to come back to later, like during a session',
    typeNewNote: 'Type a note...', noMyNotesYet: 'No notes saved yet',
    streakLabel: 'Streak', streakDesc: "Consecutive sessions you've attended without an absence",
    currentStreak: 'Current streak', bestStreak: 'Best attendance streak',
    badgesLabel: 'Badges', badgesDesc: 'Badges unlock automatically as you hit new milestones',
    attendanceBadgesTitle: 'Attendance badges', gradesBadgesTitle: 'Perfect-grade badges',
    sessionsUnit: 'sessions', fullGradeUnit: 'perfect grades',
    attendanceBadgeBronze: 'Steady Attendee', attendanceBadgeSilver: 'Standout Attendee',
    attendanceBadgeGold: 'Golden Attendance', attendanceBadgeDiamond: 'Legendary Attendance',
    gradesBadgeBronze: 'First Excellence', gradesBadgeSilver: 'High Achiever',
    gradesBadgeGold: 'Shining Star', gradesBadgeDiamond: 'Math Genius',
    tapToShareBadge: 'Tap to share', shareBadgeAria: 'Share badge',
    confirmDownloadBadge: 'Download this badge as an image?', downloadImageBtn: 'Download image',
    subscriptionStatusLabel: 'Subscription status',
    contactUs: 'Contact us', facebookLabel: 'Facebook', facebookHint: 'Follow us on Facebook',
    instagramLabel: 'Instagram', instagramHint: 'Follow us on Instagram',
    whatsappLabel: 'WhatsApp', whatsappHint: 'Message us on WhatsApp',
    telegramLabel: 'Telegram', telegramHint: 'Message our Telegram bot',
    notificationsTitle: 'Notifications', noteDetailTitle: 'Note',
    noTasksYet: 'No tasks yet', noHomeworkYet: 'No new homework',
    noteFromTeacher: 'Note from the teacher', noNotesYet: 'No notes yet',
    noNotificationsYet: 'No new notifications', openFile: 'Open file', downloadFile: 'Download file',
    homeworkNotesTab: 'Homework & notes', unpaidAllPaid: 'All students have paid',
    unpaidStudentsTitle: "Students who haven't paid", uploadHomeworkTitle: 'Upload homework',
    homeworkTitleField: 'Homework title', centerAndClassField: 'Center & class', saveHomeworkBtn: 'Save homework',
    sendNoteTitle: 'Send a note', searchByStudentName: 'Search by student name',
    chooseStudentToSearchBtn: 'Choose a student to search', targetField: 'Target', allStudentsBtn: 'All students',
    writeNotePh: 'Write the note...', sendNoteBtn: 'Send note', attendanceTabLabel: 'Attendance',
    deleteStudentPermanently: 'Delete student permanently', resetConfirmTitle: 'Confirm student promotion',
    confirmTitle: 'Confirm', confirmDeleteBtn: 'Confirm delete', sendAbsenceMessagesTitle: 'Send attendance messages',
    absenceQueueHint: 'Tap "Send" next to each student one at a time (absent or present). WhatsApp opens with the message ready — send it, then come back here for the next student.',
    chooseStudentTitle: 'Choose student', chooseStudentForNoteTitle: 'Choose a student for the note',
    chooseNoteTargetTitle: 'Choose note target', chooseCenterTitle: 'Choose center',
    noMatchingStudent: 'No matching student', typeStudentNameToSearch: 'Type a student name to search',
    noCentersYet: 'No centers yet'
  }
};

window.mcLang = function () { return localStorage.getItem('mc_lang') || 'ar'; };
window.t = function (key) {
  var dict = MC_DICT[window.mcLang()] || MC_DICT.ar;
  return dict[key] !== undefined ? dict[key] : key;
};
window.applyLangDir = function () {
  var lang = window.mcLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
};
window.toggleLang = function () {
  var next = window.mcLang() === 'ar' ? 'en' : 'ar';
  localStorage.setItem('mc_lang', next);
  window.location.reload();
};

/* ---------------- theme ---------------- */
window.applyTheme = function () {
  var theme = localStorage.getItem('mc_theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
  window.applyStatusBarColor();
};
window.toggleTheme = function () {
  var current = localStorage.getItem('mc_theme') || 'light';
  var next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('mc_theme', next);
  document.documentElement.setAttribute('data-theme', next);
  window.applyStatusBarColor();
};

// Keeps the mobile status bar (and the installed-app/PWA bar) the same
// color as the page's own background, so switching light/dark mode
// repaints it too instead of leaving it stuck on one fixed color.
window.applyStatusBarColor = function () {
  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) meta.setAttribute('content', bg);
};

/* ---------------- accent color (platform-wide, chosen by admin) ----------------
   Stored on settings.themeColor in Firebase so it's shared by every device —
   admin page and student page alike. A copy is cached in localStorage purely
   to paint the right color instantly on load, before Firebase settings arrive
   (same trick as the dark/light theme above); Firebase stays the source of truth. */
window.ACCENT_PALETTE = {
  purple: { label: 'بنفسجي', accent: '#5B21B6', accent2: '#7C3AED' },
  blue: { label: 'أزرق', accent: '#1E3A8A', accent2: '#2563EB' },
  green: { label: 'أخضر', accent: '#14532D', accent2: '#16A34A' },
  red: { label: 'أحمر', accent: '#7F1D1D', accent2: '#B91C1C' },
  orange: { label: 'برتقالي', accent: '#78350F', accent2: '#B45309' },
  teal: { label: 'فيروزي', accent: '#134E4A', accent2: '#0F766E' }
};

function mcHexToRgba(hex, alpha) {
  var value = hex.replace('#', '');
  var r = parseInt(value.substring(0, 2), 16);
  var g = parseInt(value.substring(2, 4), 16);
  var b = parseInt(value.substring(4, 6), 16);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
}

function mcApplyAccentVars(key) {
  var palette = window.ACCENT_PALETTE[key] || window.ACCENT_PALETTE.purple;
  var root = document.documentElement.style;
  root.setProperty('--accent', palette.accent);
  root.setProperty('--accent-2', palette.accent2);
  root.setProperty('--accent-soft', mcHexToRgba(palette.accent, .14));
  root.setProperty('--accent-shadow', mcHexToRgba(palette.accent, .6));
}

// For places that can't use a CSS variable directly (e.g. <canvas> drawing) —
// returns the accent color actually painted right now, alpha included.
window.getAccentColor = function (alpha) {
  var hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8B5CF6';
  if (typeof alpha === 'number') return mcHexToRgba(hex, alpha);
  return hex;
};

// Call as early as possible (right after shared.js loads) to paint the last
// known color instantly and avoid a flash of the default purple.
window.applyCachedAccent = function () {
  mcApplyAccentVars(localStorage.getItem('mc_accent') || 'purple');
};

// Call once Firebase settings are ready, and again on every live settings
// update, so every open page (admin or student) picks up a change instantly.
window.applyAccentFromSettings = function () {
  var settings = window.getSettings();
  var key = (settings && settings.themeColor) || 'purple';
  localStorage.setItem('mc_accent', key);
  mcApplyAccentVars(key);
};

// Preview only — paints the color without touching settings/localStorage,
// so the admin can see a swatch before hitting Save.
window.previewAccentColor = function (key) {
  mcApplyAccentVars(key);
};

// Keeps the browser-tab icon (favicon) in sync with the admin-configured
// platform logo (Settings → اسم المنصة → شعار المنصة). Call once Firebase
// settings are ready, and again on every live settings update — same
// pattern as applyAccentFromSettings — so every open page (login, OTP
// verify, admin, student) swaps its tab icon instantly when the logo
// changes. Falls back to whatever <link rel="icon"> the page shipped with
// if no custom logo has been set.
// Pages now ship 3 <link rel="icon"> tags (an .ico plus two PNG sizes) so
// browsers pick the sharpest one — track/restore all of them, not just the
// first, or a custom admin logo would only ever land on one of the three.
var mcDefaultFavicons = null;
window.applyFaviconFromSettings = function () {
  var links = document.querySelectorAll('link[rel="icon"]');
  if (!links.length) return;
  if (mcDefaultFavicons === null) {
    mcDefaultFavicons = Array.prototype.map.call(links, function (link) {
      return { href: link.getAttribute('href'), type: link.getAttribute('type') || '', sizes: link.getAttribute('sizes') || '' };
    });
  }
  var settings = window.getSettings();
  if (settings && settings.logo) {
    var mimeMatch = /^data:([^;]+);/.exec(settings.logo);
    var type = mimeMatch ? mimeMatch[1] : 'image/png';
    links.forEach(function (link) {
      link.setAttribute('href', settings.logo);
      link.setAttribute('type', type);
      link.removeAttribute('sizes');
    });
  } else {
    links.forEach(function (link, i) {
      var original = mcDefaultFavicons[i];
      if (!original) return;
      link.setAttribute('href', original.href);
      if (original.type) link.setAttribute('type', original.type);
      if (original.sizes) link.setAttribute('sizes', original.sizes);
      else link.removeAttribute('sizes');
    });
  }
};

/* ---------------- admin login OTP (email verification code) ----------------
   Sent via EmailJS (free tier, works straight from the browser — no backend
   needed) to the admin's own Gmail address so a second factor is required
   after the admin password. The code + expiry live briefly in Firebase under
   'adminOTP/<deviceId>' so a second device/tab can verify independently.

   The variable names below (name/title/message/time) match the existing
   "Contact Us" EmailJS template — its "To Email" field is currently fixed
   to a literal address in the EmailJS dashboard, so to_email is sent too
   but only takes effect if that field is switched to {{to_email}} later.
   ---------------------------------------------------------------------- */
window.EMAILJS_CONFIG = {
  publicKey: '4Wpi6mqXKmUrbiYww',
  serviceId: 'service_dwkiykv',
  templateId: 'template_sownf49'
};

window.mcEmailJSReady = function () {
  return typeof window.emailjs !== 'undefined'
    && window.EMAILJS_CONFIG.publicKey.indexOf('YOUR_') !== 0;
};

window.initEmailJS = function () {
  if (typeof window.emailjs !== 'undefined' && window.EMAILJS_CONFIG.publicKey.indexOf('YOUR_') !== 0) {
    window.emailjs.init({ publicKey: window.EMAILJS_CONFIG.publicKey });
  }
};

window.generateOTPCode = function () {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits, never starts with 0
};

// A longer, URL-safe random token used for the "confirm with one tap" link
// in the email — separate from the 6-digit code so either path can be used.
window.generateOTPToken = function () {
  if (window.crypto && window.crypto.getRandomValues) {
    var bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  // Fallback for environments without crypto.getRandomValues (rare).
  var out = '';
  for (var i = 0; i < 48; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
};

window.MC_OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Optional second delivery channel for the OTP: a Telegram bot. Needs a bot
// token (from @BotFather) and the admin's own chat id (the admin must have
// opened a chat with that bot at least once — Telegram never lets a bot
// message a user who hasn't started the conversation first). Both live in
// settings (telegramBotToken / adminTelegramChatId) and are optional: if
// either is missing this is skipped and email-only OTP still works exactly
// as before.
window.mcTelegramReady = function (settings) {
  settings = settings || window.getSettings() || {};
  return !!((settings.telegramBotToken || '').trim() && (settings.adminTelegramChatId || '').trim());
};

window.sendAdminOTPTelegram = function (settings, code, magicLink) {
  var botToken = (settings.telegramBotToken || '').trim();
  var chatId = (settings.adminTelegramChatId || '').trim();
  var text = 'كودك: ' + code + ' (صالح 5 دقايق)\nادخل بضغطة واحدة: ' + magicLink;
  return fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text })
  }).then(function (res) {
    if (!res.ok) throw new Error('TELEGRAM_SEND_FAILED');
    return res.json();
  });
};

// Generates a fresh code, stores it in Firebase for this device, and sends
// it to the admin over every configured channel (email always, Telegram
// too if telegramBotToken + adminTelegramChatId are both set). Resolves
// with the code's expiry once at least one channel succeeds — a failure on
// one optional channel is logged but never blocks the other.
window.createAndSendAdminOTP = function (deviceId) {
  var settings = window.getSettings() || {};
  var email = (settings.adminEmail || '').trim();
  if (!email) return Promise.reject(new Error('NO_ADMIN_EMAIL'));
  if (!window.mcEmailJSReady()) return Promise.reject(new Error('EMAILJS_NOT_CONFIGURED'));

  var code = window.generateOTPCode();
  var token = window.generateOTPToken();
  var expiresAt = Date.now() + window.MC_OTP_TTL_MS;
  var otpRef = window._mc.ref(window._mc.db, 'adminOTP/' + deviceId);
  var platformName = settings.platformName || 'Math Center';

  // One-tap confirmation link: opens admin-verify.html with the device id +
  // token in the URL, so the admin can just tap it from the email instead
  // of typing the 6-digit code. Built from the current page's own URL so it
  // works on any domain the site is hosted on without hardcoding anything.
  var magicLink = new URL('admin-verify.html', window.location.href).href
    + '?device=' + encodeURIComponent(deviceId)
    + '&token=' + encodeURIComponent(token);

  return window._mc.set(otpRef, { code: code, token: token, expiresAt: expiresAt })
    .then(function () {
      var emailPromise = window.emailjs.send(window.EMAILJS_CONFIG.serviceId, window.EMAILJS_CONFIG.templateId, {
        to_email: email,
        platform_name: platformName,
        name: platformName + ' — تنبيه أمني',
        time: new Date().toLocaleString('ar-EG'),
        otp_code: 'كودك: ' + code + ' (صالح 5 دقايق)، أو ادخل بضغطة واحدة من هنا: ' + magicLink
      });

      // Telegram is best-effort: fired in parallel, never awaited by the
      // caller and never allowed to break the email-based flow above.
      if (window.mcTelegramReady(settings)) {
        window.sendAdminOTPTelegram(settings, code, magicLink)
          .catch(function (err) { console.error('Telegram OTP send failed:', err); });
      }

      return emailPromise;
    })
    .then(function () { return { expiresAt: expiresAt, email: email }; });
};

// Re-sends a brand new code for the same device (used by the "resend" link).
window.resendAdminOTP = function (deviceId) {
  return window.createAndSendAdminOTP(deviceId);
};

// Checks the code the admin typed against what's stored in Firebase for
// this device. Removes the OTP record once it's used (success or expired)
// so a code can never be replayed.
window.verifyAdminOTP = function (deviceId, enteredCode) {
  var otpRef = window._mc.ref(window._mc.db, 'adminOTP/' + deviceId);
  return window._mc.get(otpRef).then(function (snap) {
    var data = snap.exists() ? snap.val() : null;
    if (!data) return { ok: false, reason: 'NOT_FOUND' };
    if (Date.now() > data.expiresAt) {
      window._mc.remove(otpRef);
      return { ok: false, reason: 'EXPIRED' };
    }
    if (String(enteredCode).trim() !== String(data.code)) {
      return { ok: false, reason: 'MISMATCH' };
    }
    window._mc.remove(otpRef);
    return { ok: true };
  });
};

// Same idea but for the one-tap email link: checks the long token instead
// of the 6-digit code. Shares the same Firebase record, so using either one
// invalidates both (no reuse after either path succeeds).
window.verifyAdminOTPToken = function (deviceId, token) {
  if (!token) return Promise.resolve({ ok: false, reason: 'NOT_FOUND' });
  var otpRef = window._mc.ref(window._mc.db, 'adminOTP/' + deviceId);
  return window._mc.get(otpRef).then(function (snap) {
    var data = snap.exists() ? snap.val() : null;
    if (!data) return { ok: false, reason: 'NOT_FOUND' };
    if (Date.now() > data.expiresAt) {
      window._mc.remove(otpRef);
      return { ok: false, reason: 'EXPIRED' };
    }
    if (String(token) !== String(data.token)) {
      return { ok: false, reason: 'MISMATCH' };
    }
    window._mc.remove(otpRef);
    return { ok: true };
  });
};

/* ---------------- session ---------------- */
window.setSession = function (session) {
  if (!session || (session.role !== 'admin' && session.role !== 'student')) return null;
  var normalized = { role: session.role };
  if (session.role === 'student') {
    if (session.studentId === undefined || session.studentId === null || String(session.studentId).trim() === '') return null;
    normalized.studentId = String(session.studentId);
  }
  mcWrite(DB_KEYS.SESSION, normalized);
  return normalized;
};
window.getSession = function () {
  var session = mcRead(DB_KEYS.SESSION, null);
  if (!session || (session.role !== 'admin' && session.role !== 'student')) return null;
  if (session.role === 'student' && (session.studentId === undefined || session.studentId === null || String(session.studentId).trim() === '')) return null;
  return session.role === 'student'
    ? { role: 'student', studentId: String(session.studentId) }
    : { role: 'admin' };
};
window.clearSession = function () { localStorage.removeItem(DB_KEYS.SESSION); };

window.whenMCReady = function (cb) {
  if (typeof cb !== 'function') return;
  if (typeof window.onMCReady === 'function') window.onMCReady(cb);
  else window.addEventListener('mc-ready', cb, { once: true });
};

/* ---------------- toast ---------------- */
/* ---------------- overlay/modal helper ---------------- */
// Closes every currently-open modal/overlay (.overlay.open) and the chat
// panel (.chat-overlay.open, used on the student page) in one call. Wired
// into the bottom navigation bars so switching sections always closes any
// popup that was left open, instead of leaving it stuck on screen.
window.closeAllOverlays = function () {
  document.querySelectorAll('.overlay.open, .chat-overlay.open').forEach(function (el) {
    el.classList.remove('open');
  });
};

window.mcToast = function (message) {
  var wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  var el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(function () {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(function () { el.remove(); }, 250);
  }, 2200);
};

/* ---------- topbar hamburger menu (theme / language / logout) ---------- */
window.toggleTopbarMenu = function (event) {
  if (event) event.stopPropagation();
  var panel = document.getElementById('topbarMenuPanel');
  if (panel) panel.classList.toggle('open');
};
window.closeTopbarMenu = function () {
  var panel = document.getElementById('topbarMenuPanel');
  if (panel) panel.classList.remove('open');
};
/* Close the menu on any click outside it (its own button included, since
   toggleTopbarMenu already handles opening/closing on that click). */
document.addEventListener('click', function (event) {
  var panel = document.getElementById('topbarMenuPanel');
  if (panel && panel.classList.contains('open') && !panel.contains(event.target)) {
    panel.classList.remove('open');
  }
});

window.openModal = function (id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.add('open');
};
window.closeModal = function (id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
};

/* Close modal surfaces when the user clicks their backdrop. */
document.addEventListener('click', function (event) {
  var surface = event.target;
  if (surface && (surface.classList.contains('overlay') || surface.classList.contains('chat-overlay')) && event.target === surface) {
    surface.classList.remove('open');
  }
});

/* ---------------- whatsapp helper ---------------- */
window.COUNTRY_DIAL_CODES = [
  { code: '20', flag: '🇪🇬', label: 'مصر' },
  { code: '966', flag: '🇸🇦', label: 'السعودية' },
  { code: '971', flag: '🇦🇪', label: 'الإمارات' },
  { code: '965', flag: '🇰🇼', label: 'الكويت' },
  { code: '974', flag: '🇶🇦', label: 'قطر' },
  { code: '973', flag: '🇧🇭', label: 'البحرين' },
  { code: '968', flag: '🇴🇲', label: 'عُمان' },
  { code: '962', flag: '🇯🇴', label: 'الأردن' },
  { code: '961', flag: '🇱🇧', label: 'لبنان' },
  { code: '963', flag: '🇸🇾', label: 'سوريا' },
  { code: '964', flag: '🇮🇶', label: 'العراق' },
  { code: '970', flag: '🇵🇸', label: 'فلسطين' },
  { code: '218', flag: '🇱🇾', label: 'ليبيا' },
  { code: '249', flag: '🇸🇩', label: 'السودان' },
  { code: '967', flag: '🇾🇪', label: 'اليمن' },
  { code: '212', flag: '🇲🇦', label: 'المغرب' },
  { code: '213', flag: '🇩🇿', label: 'الجزائر' },
  { code: '216', flag: '🇹🇳', label: 'تونس' },
  { code: '39', flag: '🇮🇹', label: 'إيطاليا' },
  { code: '33', flag: '🇫🇷', label: 'فرنسا' },
  { code: '34', flag: '🇪🇸', label: 'إسبانيا' },
  { code: '1', flag: '🇺🇸', label: 'أمريكا' }
];

// Combine a chosen dial code with a locally-typed number into one
// international number (e.g. '20' + '01012345678' -> '+201012345678').
// Strips a leading 0 (the usual "local" prefix) and any non-digits first.
window.formatIntlPhone = function (dialCode, localNumber) {
  var digits = (localNumber || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  return '+' + dialCode + digits;
};

window.openWhatsApp = function (phone, message) {
  if (!phone) return;
  var digits = phone.replace(/[^0-9]/g, '');
  // Assume Egyptian local numbers (starting 01x) -> country code 2[cite: 12]
  if (digits.startsWith('0')) digits = '2' + digits;
  var url = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(message);
  window.open(url, '_blank');
};

/* ---------------- telegram helper ----------------
   The bot's token — used straight from the browser since this platform has
   no backend server. The Telegram Bot API accepts cross-origin requests, so
   a plain fetch() from here works. Note this does mean the token sits in
   the page's own source, visible to anyone who opens dev tools; that's an
   accepted trade-off of having no server, but it means anyone with this
   token could send messages as the bot or read its chats — don't publish
   this file's source elsewhere without swapping the token out. */
window.TELEGRAM_BOT_TOKEN = '8771093797:AAFUliHsm3V42xZDggTenrAqtERlSim1NBQ';
window.TELEGRAM_BOT_USERNAME = 'almokhtar_plattform_bot';

// Sends a message straight to one Telegram chat via the Bot API. Unlike the
// WhatsApp wa.me links (which have to open the WhatsApp app for the admin to
// press send), this fires in the background over fetch() — so it can run
// automatically, for every guardian at once, with no tapping needed.
// Resolves true/false depending on whether Telegram accepted it.
window.sendTelegramMessage = function (chatId, text) {
  if (!chatId) return Promise.resolve(false);
  var url = 'https://api.telegram.org/bot' + window.TELEGRAM_BOT_TOKEN + '/sendMessage';
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text })
  }).then(function (res) {
    if (!res.ok) {
      res.json().then(function (d) { console.error('Telegram rejected the message:', chatId, d && d.description); })
        .catch(function () { console.error('Telegram rejected the message:', chatId, res.status); });
    }
    return res.ok;
  }).catch(function (err) { console.error('Telegram send failed:', err); return false; });
};

/* ---------------- whatsapp AUTO-send (UltraMsg gateway) ----------------
   Same idea as the Telegram helper above: a plain fetch() from the browser,
   no tapping needed. Messages go out through the WhatsApp number linked to
   the UltraMsg instance. They are sent ONE AT A TIME with a 2-4 second gap
   (a queue) so a big batch doesn't look like spam to WhatsApp.
   NOTE: like the Telegram token, this token sits in the page source. */
window.ULTRAMSG_INSTANCE = 'instance194679';
window.ULTRAMSG_TOKEN = '8bnpflsbwhicarg7';

window.normalizeWhatsAppNumber = function (phone) {
  var digits = String(phone || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.indexOf('00') === 0) digits = digits.slice(2);
  else if (digits.charAt(0) === '0') digits = '2' + digits; // Egyptian local number 01x -> 201x
  return digits;
};

var _waChain = Promise.resolve();
window.sendWhatsAppAuto = function (phone, text) {
  var to = window.normalizeWhatsAppNumber(phone);
  if (!to) return Promise.resolve(false);
  var job = _waChain.then(function () {
    var body = new URLSearchParams();
    body.append('token', window.ULTRAMSG_TOKEN);
    body.append('to', to);
    body.append('body', text);
    return fetch('https://api.ultramsg.com/' + window.ULTRAMSG_INSTANCE + '/messages/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        var ok = !!data && !data.error && (data.sent === 'true' || data.sent === true);
        if (!ok) console.error('UltraMsg rejected the message:', data);
        return ok;
      })
      .catch(function (err) { console.error('UltraMsg send failed:', err); return false; });
  });
  _waChain = job.then(function () {
    return new Promise(function (resolve) { setTimeout(resolve, 2000 + Math.random() * 2000); });
  });
  return job;
};

// One call to reach a student's guardian on EVERY channel available:
// Telegram (if a chat ID is linked) + WhatsApp (if a phone number exists).
// Resolves { telegram, whatsapp, any } — `any` is true if at least one got through.
window.sendGuardianMessage = function (student, text) {
  var tg = student && student.telegramChatId
    ? window.sendTelegramMessage(student.telegramChatId, text) : Promise.resolve(false);
  var wa = student && student.phone
    ? window.sendWhatsAppAuto(student.phone, text) : Promise.resolve(false);
  return Promise.all([tg, wa]).then(function (r) {
    return { telegram: r[0], whatsapp: r[1], any: !!(r[0] || r[1]) };
  });
};

// Telegram has no way to "push" a first message to an arbitrary phone
// number — a chat_id only exists once that person has said something to
// the bot at least once (e.g. pressed Start). This reads the bot's recent
// incoming messages (getUpdates) so the admin can see who has messaged it
// and copy the right chat_id in against a student. Returns an array of
// { chatId, name, username, text } from most to least recent, deduplicated
// by chat (each chat kept once, its latest message).
window.fetchTelegramChats = function () {
  var url = 'https://api.telegram.org/bot' + window.TELEGRAM_BOT_TOKEN + '/getUpdates?limit=100';
  return fetch(url).then(function (res) { return res.json(); }).then(function (data) {
    if (!data || !data.ok || !data.result) return [];
    var seen = {};
    var out = [];
    data.result.slice().reverse().forEach(function (update) {
      var msg = update.message || update.channel_post;
      if (!msg || !msg.chat) return;
      var chatId = msg.chat.id;
      if (seen[chatId]) return;
      seen[chatId] = true;
      var name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.title || '';
      out.push({ chatId: chatId, name: name, username: msg.chat.username || '', text: msg.text || '' });
    });
    return out;
  }).catch(function () { return []; });
};

/* ---------------- avatar file -> dataURL ---------------- */
window.fileToDataUrl = function (file, cb) {
  var reader = new FileReader();
  reader.onload = function (e) { cb(e.target.result); };
  reader.readAsDataURL(file);
};

// Like fileToDataUrl, but downsizes the image first via a canvas. Raw
// phone-camera photos can be several MB, and a multi-MB base64 string
// stuffed into a single Realtime Database field can fail to write with
// no visible error — the UI would say "saved" while nothing actually
// persisted. Shrinking to a sane max dimension keeps the result small
// (a few KB to ~100KB) and reliable. PNGs are kept as PNG (to preserve
// transparency); everything else is re-encoded as JPEG.
//
// Phone photos (especially iPhone HEIC/HEIC-style camera captures) can
// fail to decode into an <img>/canvas in some mobile browsers. When that
// happens we must NOT fall back to the raw, un-resized file — that raw
// file is exactly the multi-MB blob this function exists to avoid, and
// saving it silently reproduces the "looks saved, never persists" bug,
// just from a phone instead of a computer. So a decode failure reports
// back as no dataUrl, same as a FileReader failure, and the caller shows
// its existing "couldn't read the image, try another one" message.
window.fileToResizedDataUrl = function (file, maxDim, quality, cb) {
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      var isPng = file.type === 'image/png';
      try {
        cb(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', quality || 0.85));
      } catch (err) {
        cb(null); // e.g. a tainted/unsupported canvas source — never fall back to the raw file
      }
    };
    img.onerror = function () { cb(null); }; // couldn't decode (e.g. HEIC) — don't save the raw multi-MB file instead
    img.src = e.target.result;
  };
  reader.onerror = function () { cb(null); };
  reader.readAsDataURL(file);
};

/* ---------------- homework file upload (Firebase Storage) ----------------
   Uploads the file to Storage and resolves { url, path }. Only the small
   download URL is saved in the database, so the homework list stays light
   and loads fast on every device. Images are downsized first (phone photos
   are often several MB); PDFs and everything else upload as-is. */
function mcPrepareUploadBlob(file, cb) {
  var isResizable = /^image\/(jpeg|png|webp)$/.test(file.type);
  if (!isResizable) { cb(file); return; }
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var maxDim = 1800, w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      var isPng = file.type === 'image/png';
      try {
        canvas.toBlob(function (blob) { cb(blob && blob.size < file.size ? blob : file); }, isPng ? 'image/png' : 'image/jpeg', 0.85);
      } catch (err) { cb(file); }
    };
    img.onerror = function () { cb(file); };
    img.src = e.target.result;
  };
  reader.onerror = function () { cb(file); };
  reader.readAsDataURL(file);
}

window.uploadHomeworkFile = function (file, onProgress) {
  return new Promise(function (resolve, reject) {
    var S = window._mcStorage;
    if (!S) { reject(new Error('storage-unavailable')); return; }
    mcPrepareUploadBlob(file, function (blob) {
      var safeName = String(file.name || 'file').replace(/[^\w.\-]+/g, '_');
      var path = 'homework/' + Date.now() + '_' + safeName;
      var task = S.uploadBytesResumable(S.ref(S.storage, path), blob, { contentType: blob.type || file.type || 'application/octet-stream' });
      task.on('state_changed', function (snap) {
        if (typeof onProgress === 'function' && snap.totalBytes) onProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100));
      }, reject, function () {
        S.getDownloadURL(task.snapshot.ref).then(function (url) { resolve({ url: url, path: path }); }, reject);
      });
    });
  });
};

/* ---------------- site credit (shown on every page) ---------------- */
window.renderSiteCredit = function () {
  if (document.getElementById('mcSiteCredit')) return;
  var el = document.createElement('div');
  el.id = 'mcSiteCredit';
  el.className = 'mc-site-credit';
  el.textContent = 'Created by Khaled Mokhtar with Abdalla Elsharkawi';
  document.body.appendChild(el);
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', window.renderSiteCredit);
} else {
  window.renderSiteCredit();
}

/* ---------------- PWA install (service worker + "install app" bar) ----------------
   Registers service-worker.js (required by Chrome/Android before it will
   consider the site installable) and, once the browser fires
   'beforeinstallprompt', shows a small dismissible top bar with an "تثبيت"
   button instead of relying purely on Chrome's own mini-infobar — that one
   is easy to miss/swipe away and doesn't fire on every visit. A dismiss is
   remembered for 7 days so the bar doesn't nag on every page load. Safari/
   iOS never fires 'beforeinstallprompt' (no native install API there), so
   it gets a one-line manual-instructions bar instead. Does nothing if the
   app is already installed (running in standalone display mode).
   ========================================================= */
var PWA_DISMISS_KEY = 'mc_pwa_install_dismissed_at';
var mcDeferredInstallPrompt = null;

function mcIsStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function mcInstallDismissedRecently() {
  var raw = localStorage.getItem(PWA_DISMISS_KEY);
  if (!raw) return false;
  return (Date.now() - parseInt(raw, 10)) < (7 * 24 * 60 * 60 * 1000);
}

function mcShowInstallBar(onGo, isIOS) {
  if (document.getElementById('pwaInstallBar')) return;
  var bar = document.createElement('div');
  bar.className = 'pwa-install-bar';
  bar.id = 'pwaInstallBar';
  bar.innerHTML =
    '<img src="icon-192.png" alt="">' +
    '<span>' + (isIOS
      ? 'لتثبيت التطبيق: اضغط زر المشاركة ثم "إضافة إلى الشاشة الرئيسية"'
      : 'ثبّت المنصة على جهازك زي أي تطبيق عادي') + '</span>' +
    (isIOS ? '' : '<button type="button" class="pwa-install-go">تثبيت</button>') +
    '<button type="button" class="pwa-install-close" aria-label="إغلاق">×</button>';
  document.body.appendChild(bar);
  requestAnimationFrame(function () { bar.classList.add('show'); });

  function dismiss() {
    localStorage.setItem(PWA_DISMISS_KEY, String(Date.now()));
    bar.classList.remove('show');
    setTimeout(function () { bar.remove(); }, 300);
  }
  bar.querySelector('.pwa-install-close').addEventListener('click', dismiss);
  var goBtn = bar.querySelector('.pwa-install-go');
  if (goBtn) {
    goBtn.addEventListener('click', function () {
      dismiss();
      if (onGo) onGo();
    });
  }
}

function initPWAInstall() {
  if (mcIsStandalone()) return; // already running as the installed app

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(function (e) {
      console.error('service worker registration failed', e);
    });
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    mcDeferredInstallPrompt = event;
    if (mcInstallDismissedRecently()) return;
    mcShowInstallBar(function () {
      if (!mcDeferredInstallPrompt) return;
      mcDeferredInstallPrompt.prompt();
      mcDeferredInstallPrompt.userChoice.finally(function () {
        mcDeferredInstallPrompt = null;
      });
    }, false);
  });

  window.addEventListener('appinstalled', function () {
    var bar = document.getElementById('pwaInstallBar');
    if (bar) bar.remove();
    mcDeferredInstallPrompt = null;
  });

  // iOS Safari: no beforeinstallprompt, so show manual instructions instead
  // (only on actual iOS devices, and only in Safari's own browser chrome —
  // in-app browsers like Instagram's can't install PWAs either way).
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (isIOS && !mcInstallDismissedRecently()) {
    mcShowInstallBar(null, true);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPWAInstall);
} else {
  initPWAInstall();
}

/* ---------------- initials ---------------- */
window.initials = function (name) {
  if (!name) return '?';
  var parts = name.trim().split(/\s+/);
  return (parts[0][0] || '') + (parts[1] ? parts[1][0] : '');
};
