/* =========================================================
   Math Center Platform — Firebase bridge
   Loaded as a <script type="module"> BEFORE shared.js.
   Exposes a small pub/sub + cache on window that shared.js
   reads/writes against, so the rest of the app never talks
   to the Firebase SDK directly.

   ⚠️ Firebase Realtime Database rules: a brand-new project
   denies all read/write by default. For this app to work,
   open Firebase console → Realtime Database → Rules, and set:
     { "rules": { ".read": true, ".write": true } }
   (fine for testing / a closed classroom tool; tighten later
   with real auth if you open this up publicly.)
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
    getDatabase, ref, onValue, get, set, update, push, remove
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import {
    getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyCrbAnfGxZVC5FhJMFdNerss87daqRypEA",
    authDomain: "almokhtar-c024b.firebaseapp.com",
    databaseURL: "https://almokhtar-c024b-default-rtdb.firebaseio.com",
    projectId: "almokhtar-c024b",
    storageBucket: "almokhtar-c024b.firebasestorage.app",
    messagingSenderId: "110459628240",
    appId: "1:110459628240:web:3cbcec20c2517ada4d8cd5"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const storage = getStorage(app);
storage.maxUploadRetryTime = 20000; // fail fast (20s) instead of retrying for 10 minutes if Storage isn't enabled / is offline

var DEFAULT_SETTINGS = {
    platformName: 'مركز الرياضيات',
    platformNameEn: 'Math Center',
    logo: '',
    adminPassword: 'admin123',
    adminEmail: 'adminkhaledplattform@gmail.com',
    loginBgMobile: '',
    loginBgDesktop: '',
    themeColor: 'purple',
    centers: ['جمعية', 'إديوكيشن'],
    classes: [
        { id: 'g1', name: 'الأول الإعدادي', nameEn: 'Prep 1', code: '1001' },
        { id: 'g2', name: 'الثاني الإعدادي', nameEn: 'Prep 2', code: '1002' },
        { id: 'g3', name: 'الثالث الإعدادي', nameEn: 'Prep 3', code: '1003' },
        { id: 's1', name: 'الأول الثانوي', nameEn: 'Sec 1', code: '2001' },
        { id: 's2', name: 'الثاني الثانوي', nameEn: 'Sec 2', code: '2002' },
        { id: 's3', name: 'الثالث الثانوي', nameEn: 'Sec 3', code: '2003' }
    ]
};

// expose the raw SDK pieces so shared.js can write without importing anything
window._mc = { db: db, ref: ref, get: get, set: set, update: update, push: push, remove: remove };

// Firebase Storage pieces (used by shared.js uploadHomeworkFile for homework PDFs/images)
window._mcStorage = { storage: storage, ref: storageRef, uploadBytesResumable: uploadBytesResumable, getDownloadURL: getDownloadURL };

window._mcCache = { settings: null, students: [], attendance: [], grades: [], homework: [], notes: [], notifications: [] };
window._mcReady = { settings: false, students: false, attendance: false, grades: false, homework: false, notes: false, notifications: false };
window._mcListeners = { settings: [], students: [], attendance: [], grades: [], homework: [], notes: [], notifications: [] };
window._mcReadyCallbacks = [];

function notify(type) {
    if (Array.isArray(window._mcListeners[type])) {
        window._mcListeners[type].forEach(function (cb) {
            try { cb(); } catch (e) { console.error(e); }
        });
    }
}

function checkAllReady() {
    if (window._mcReady.settings && window._mcReady.students && window._mcReady.attendance && window._mcReady.grades && window._mcReady.homework && window._mcReady.notes && window._mcReady.notifications) {
        var cbs = window._mcReadyCallbacks.slice();
        window._mcReadyCallbacks = [];
        cbs.forEach(function (cb) {
            try { cb(); } catch (e) { console.error(e); }
        });
        window.dispatchEvent(new Event('mc-ready'));
    }
}

window.onMCUpdate = function (type, cb) {
    if (window._mcListeners[type]) {
        window._mcListeners[type].push(cb);
    }
};

window.onMCReady = function (cb) {
    if (typeof cb !== 'function') return;
    if (window._mcReady.settings && window._mcReady.students && window._mcReady.attendance && window._mcReady.grades) {
        cb();
    } else {
        window._mcReadyCallbacks.push(cb);
    }
};

// Settings realtime sync
var settingsRef = ref(db, 'settings');
onValue(settingsRef, function (snap) {
    var val = snap.val();
    if (!val) {
        val = DEFAULT_SETTINGS;
        set(settingsRef, DEFAULT_SETTINGS);
    }
    window._mcCache.settings = val;
    window._mcReady.settings = true;
    checkAllReady();
    notify('settings');
}, function (err) {
    console.error('Firebase settings read failed — check Realtime Database rules.', err);
    window._mcCache.settings = DEFAULT_SETTINGS;
    window._mcReady.settings = true;
    checkAllReady();
});

// Students realtime sync
var studentsRef = ref(db, 'students');
onValue(studentsRef, function (snap) {
    var val = snap.val() || {};
    window._mcCache.students = Object.keys(val).map(function (k) { var s = val[k]; s.id = k; return s; });
    window._mcReady.students = true;
    checkAllReady();
    notify('students');
}, function (err) {
    console.error('Firebase students read failed — check Realtime Database rules.', err);
    window._mcReady.students = true;
    checkAllReady();
});

// Attendance realtime sync
var attendanceRef = ref(db, 'attendance');
onValue(attendanceRef, function (snap) {
    var val = snap.val() || {};
    window._mcCache.attendance = Object.keys(val).map(function (k) { var a = val[k]; a.id = k; return a; });
    window._mcReady.attendance = true;
    checkAllReady();
    notify('attendance');
}, function (err) {
    console.error('Firebase attendance read failed — check Realtime Database rules.', err);
    window._mcReady.attendance = true;
    checkAllReady();
});

// Grades realtime sync
var gradesRef = ref(db, 'grades');
onValue(gradesRef, function (snap) {
    var val = snap.val() || {};
    window._mcCache.grades = Object.keys(val).map(function (k) { var g = val[k]; g.id = k; return g; });
    window._mcReady.grades = true;
    checkAllReady();
    notify('grades');
}, function (err) {
    console.error('Firebase grades read failed — check Realtime Database rules.', err);
    window._mcReady.grades = true;
    checkAllReady();
});

function watchCollection(type) {
    onValue(ref(db, type), function (snap) {
        var val = snap.val() || {};
        window._mcCache[type] = Object.keys(val).map(function (k) { var item = val[k]; item.id = k; return item; });
        window._mcReady[type] = true;
        checkAllReady();
        notify(type);
    }, function (err) {
        console.error('Firebase ' + type + ' read failed.', err);
        window._mcReady[type] = true;
        checkAllReady();
    });
}

watchCollection('homework');
watchCollection('notes');
watchCollection('notifications');

// Implementation of FirebaseSync helpers
function saveStudentToCloud(studentData) {
    if (studentData.id) {
        var currentRef = ref(db, 'students/' + studentData.id);
        return set(currentRef, studentData);
    } else {
        var newRef = push(ref(db, 'students'));
        studentData.id = newRef.key;
        return set(newRef, studentData);
    }
}

function recordAttendance(attendanceData) {
    var newRef = push(ref(db, 'attendance'));
    if (!attendanceData.id) attendanceData.id = newRef.key;
    return set(newRef, attendanceData);
}

function listenToStudentsRealtime(cb) {
    if (typeof cb === 'function') {
        window.onMCUpdate('students', function () {
            cb(window._mcCache.students);
        });
    }
}

// Export functions safely on window.FirebaseSync
window.FirebaseSync = {
    recordAttendance: recordAttendance,
    saveStudentToCloud: saveStudentToCloud,
    listenToStudentsRealtime: listenToStudentsRealtime
};