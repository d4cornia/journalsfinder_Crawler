const db = require("./connection");
const jwt = require("jsonwebtoken");

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


module.exports = {
    cekJWT: cekJWT,
};
