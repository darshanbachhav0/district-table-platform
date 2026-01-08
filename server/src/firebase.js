const admin = require("firebase-admin");

let _db = null;

function initFirebase() {
  if (_db) return _db;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (privateKey) privateKey = privateKey.replace(/\\n/g, "\n");

  const hasCert = projectId && clientEmail && privateKey;
  if (!hasCert) {
    throw new Error("Missing Firebase credentials. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in environment.");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey })
    });
  }

  _db = admin.firestore();
  _db.settings({ ignoreUndefinedProperties: true });
  return _db;
}

function db() {
  return initFirebase();
}

module.exports = { initFirebase, db };
