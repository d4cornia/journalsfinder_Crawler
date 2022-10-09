const db = require("./connection");
const jwt = require("jsonwebtoken");
const CryptoJS = require("crypto-js");

async function cekJWT(req, res, next) {
    if (!req.headers["x-auth-token"]) {
        return res.status(403).json({
            error_msg: "Unauthorized!",
            status : 'Error'
        });
    }
    let token = req.headers["x-auth-token"];

    let user = null;
    try {
        user = jwt.verify(token, process.env.secret);
    } catch (e) {
        console.log(e);
        return res.status(401).json({
            error_msg: "Invalid Token",
            status : 'Error'
        });
    }

    // batasan waktu
    // hasil dalam second
    // console.log(new Date().getTime()/1000 - user.iat);
    // if(new Date().getTime()/1000 - user.iat > 900){
    //     return res.status(401).json({
    //         'err': 'Token expired'
    //     });
    // }
    if(!user) {
        return res.status(501).json({
            error_msg: "System Error",
            status : 'Error'
        });
    }

    let resu = await db.query(
        `SELECT * FROM users WHERE email='${user.email}' AND password='${user.password}' AND deleted_at IS NULL`
    );

    req.user = resu[0]; // jika suskses maka akan mendapatkan user yang diverfikasi jwt
    
    next();
}

async function verifyAppMachine(req, res, next) {
    if (!req.headers["x-app-machine-token"]) {
        return res.status(403).json({
            error_msg: "Unauthorized!",
            status: 'Error'
        });
    }

    console.log('pure : ' + req.headers["x-app-machine-token"])
    console.log('pure2 : ' + CryptoJS.SHA3(CryptoJS.SHA3(process.env.encryption_key, { outputLength: 512 }).toString(CryptoJS.enc.Hex), { outputLength: 512 }).toString(CryptoJS.enc.Hex))
    if(CryptoJS.SHA3
        (CryptoJS.SHA3
        (CryptoJS.SHA3
        (CryptoJS.SHA3
        (process.env.encryption_key, { outputLength: 512 }).toString(CryptoJS.enc.Hex), { outputLength: 512 }).toString(CryptoJS.enc.Hex), { outputLength: 512 }), { outputLength: 512 }).toString(CryptoJS.enc.Hex) + 'j'
        !==
        CryptoJS.SHA3(
            CryptoJS.SHA3(req.headers["x-app-machine-token"], { outputLength: 512 }), { outputLength: 512 }).toString(CryptoJS.enc.Hex) + 'j') {
        return res.status(403).json({
            error_msg: "Unauthorized not match!",
            status: 'Error'
        });
    }

    next();
}


async function verifyCode(req, res, next) {
    let resu = await db.query(
        `SELECT * FROM users WHERE email='${req.body.email}'`
    );
    if (resu[0].verification_code == "-") {
        return res.status(400).json({
            message: "Request Verification code dulu!",
            data: {},
            status: "Error",
        });
    }
    if (req.body.verification_code != resu[0].verification_code) {
        return res.status(400).json({
            message: "Verification code yang dimasukan salah!",
            data: {},
            status: "Error",
        });
    }

    next();
}


async function authAdmin(req, res, next) {
    if (req.user.status != 3) {
        return res.status(403).json({
            message: "Unauthorized user",
            data: {},
            status: "Error",
        });
    }

    next();
}

async function authUser(req, res, next) {
    if (req.user.status != 1) {
        return res.status(403).json({
            message: "Unauthorized user",
            data: {},
            status: "Error",
        });
    }

    next();
}

module.exports = {
    cekJWT: cekJWT,
    verifyAppMachine: verifyAppMachine,
    verifyCode: verifyCode,
    authAdmin: authAdmin,
    authUser: authUser,
};
