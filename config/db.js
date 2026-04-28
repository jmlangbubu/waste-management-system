const mysql = require('mysql2');
const dotenv = require('dotenv');

dotenv.config();

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306, 
  connectTimeout: 10000
});

db.connect((err) => {
  if (err) {
    console.error(' Database connection failed:');
    console.error(err); // full error (important for Render logs)
    return;
  }
  console.log(' MySQL connected successfully');
});

module.exports = db;
