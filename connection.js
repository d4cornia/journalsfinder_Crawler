const mysql = require("mysql");
const pool = mysql.createPool({
    host: "remotemysql.com",
    user: "XMMdWlz3OZ",
    password: "ExpGj7pYJn",
    database: "XMMdWlz3OZ"
});

// var pool = mysql.createPool({
//     host: "localhost",
//     user: "root",
//     password: "",
//     database: "journal_finder"
// });

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