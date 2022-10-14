const express = require("express");
const app = express();
require('dotenv').config(); // setting up
const cors = require('cors')

app.use(cors())
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 3001;

const crawler = require('./routes/crawler');
app.use('/api/crawler/', crawler);

// LISTENING
app.listen(port, function(){
    console.log(`Listening to port ${port}`);
});
