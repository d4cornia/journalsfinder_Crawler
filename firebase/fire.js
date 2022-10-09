const fs = require('firebase-admin');

const serviceAccount = require('./kantin-sehat-firebase-adminsdk-zmiud-09bc948f48.json');

fs.initializeApp({
    credential: fs.credential.cert(serviceAccount)
});

const firedb = fs.firestore();

module.exports = firedb