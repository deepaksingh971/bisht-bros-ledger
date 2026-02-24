require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// --- MongoDB Connection ---
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)  // options removed for Mongoose 7+
    .then(() => {
        console.log("✅ MongoDB Connected Successfully!");
        migrateData(); // migrate old JSON data
    })
    .catch(err => console.log("❌ Connection Error: ", err.message));

// --- Schemas ---
const UserSchema = new mongoose.Schema({ 
    mobile: { type: String, required: true }, 
    password: { type: String, required: true }, 
    name: String, 
    role: String 
});

const RecordSchema = new mongoose.Schema({ 
    name: String, 
    amount: String, 
    date: String, 
    status: String 
});

const User = mongoose.model('User', UserSchema);
const Record = mongoose.model('Record', RecordSchema);

// --- Data Migration ---
async function migrateData() {
    try {
        if (fs.existsSync('./users.json')) {
            const oldUsers = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
            for (let user of oldUsers) {
                await User.findOneAndUpdate({ mobile: user.mobile }, user, { upsert: true });
            }
            console.log("👤 Users migrated to MongoDB");
        }

        if (fs.existsSync('./data.json')) {
            const oldRecords = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
            for (let rec of oldRecords) {
                await Record.findOneAndUpdate({ name: rec.name, date: rec.date }, rec, { upsert: true });
            }
            console.log("📊 Ledger records migrated to MongoDB");
        }
    } catch (err) {
        console.log("⚠️ Migration Warning: ", err.message);
    }
}

// --- API ROUTES ---
// Signup
app.post('/api/signup', async (req, res) => {
    try {
        const { mobile, password, name } = req.body;
        const exists = await User.findOne({ mobile });
        if (exists) return res.status(400).json({ error: "Already registered!" });
        
        const count = await User.countDocuments();
        const role = count === 0 ? 'admin' : 'viewer';
        
        const newUser = new User({ mobile, password, name, role });
        await newUser.save();
        res.json({ success: true, role });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login
app.post('/api/login', async (req, res) => {
    const { mobile, password } = req.body;
    const user = await User.findOne({ mobile, password });
    if (user) {
        res.json({ success: true, user: { name: user.name, mobile: user.mobile, role: user.role } });
    } else {
        res.status(401).json({ error: "Invalid credentials!" });
    }
});

// Get All Records
app.get('/api/records', async (req, res) => {
    const records = await Record.find();
    res.json(records);
});

// Add/Update Record (Admin Only)
app.post('/api/records', async (req, res) => {
    const { name, amount, date, status, mobile, password } = req.body;
    const user = await User.findOne({ mobile, password });
    
    if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied: Admin Only" });
    }

    await Record.findOneAndUpdate(
        { name, date },
        { amount, status },
        { upsert: true, new: true }
    );
    res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server Live on Port ${PORT}`));
