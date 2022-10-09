const mysql = require("mysql");
const pool = mysql.createPool({
    host: "remotemysql.com",
    user: "XMMdWlz3OZ",
    password: "ExpGj7pYJn",
    database: "XMMdWlz3OZ"
});

const q = async (query, param) => {
    return new Promise((resolve, reject) => {
        pool.query(query, param, (err, rows, fields) => {
            if (err) reject(err);
            else resolve(rows);
        })
    })
}

module.exports= {
    'query' : q,
}