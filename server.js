const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://YOUR_USER:YOUR_PASS@cluster0.xxxxx.mongodb.net/BishtBros?retryWrites=true&w=majority";

// ── HELPERS ──
function hashPassword(p) { return crypto.createHash('sha256').update(p + 'bisht_salt_2026').digest('hex'); }
function genToken(mobile) { return crypto.createHash('sha256').update(mobile + Date.now() + 'bb_secret').digest('hex'); }

const sessions = new Map();

// ── SCHEMAS ──
const UserSchema = new mongoose.Schema({ mobile: { type: String, required: true, unique: true }, password: { type: String, required: true }, name: { type: String, required: true }, role: { type: String, enum: ['admin','viewer'], default: 'viewer' } }, { timestamps: true });

const RecordSchema = new mongoose.Schema({ name: String, amount: { type: Number, default: 500 }, date: String, status: { type: String, enum: ['Pending','Done'], default: 'Pending' } }, { timestamps: true });

const ExpenseSchema = new mongoose.Schema({ description: { type: String, required: true }, amount: { type: Number, required: true }, date: { type: String, required: true }, category: { type: String, default: 'Other' } }, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Record = mongoose.model('Record', RecordSchema);
const Expense = mongoose.model('Expense', ExpenseSchema);

// ── CONNECT ──
mongoose.connect(MONGO_URI)
    .then(() => { console.log("✅ MongoDB Connected!"); migrateData(); })
    .catch(err => console.log("❌ Connection Error:", err.message));

// ── MIGRATE ──
async function migrateData() {
    try {
        if (fs.existsSync('./users.json')) {
            const old = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
            for (let u of old) {
                const pwd = u.password.length === 64 ? u.password : hashPassword(u.password);
                await User.findOneAndUpdate({ mobile: u.mobile }, { ...u, password: pwd }, { upsert: true });
            }
            console.log("👤 Users migrated");
        }
        if (fs.existsSync('./data.json')) {
            const old = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
            for (let r of old) await Record.findOneAndUpdate({ name: r.name, date: r.date }, { ...r, amount: Number(r.amount) || 500 }, { upsert: true });
            console.log("📊 Records migrated");
        }
    } catch (e) { console.log("⚠ Migration:", e.message); }
}

// ── AUTH MIDDLEWARE ──
async function requireAdmin(req, res, next) {
    const { mobile, token } = req.body;
    if (token && sessions.has(token)) {
        const s = sessions.get(token);
        if (s.mobile === mobile && s.role === 'admin') { req.admin = s; return next(); }
    }
    return res.status(403).json({ error: "Access Denied: Admin only" });
}

// ── ROUTES ──

// Signup
app.post('/api/signup', async (req, res) => {
    try {
        const { mobile, password, name } = req.body;
        if (!mobile || !password || !name) return res.status(400).json({ error: "All fields required" });
        if (password.length < 6) return res.status(400).json({ error: "Password min 6 chars" });
        if (await User.findOne({ mobile })) return res.status(400).json({ error: "Mobile already registered!" });
        const count = await User.countDocuments();
        const role = count === 0 ? 'admin' : 'viewer';
        await new User({ mobile, password: hashPassword(password), name: name.trim(), role }).save();
        console.log(`✅ ${role} registered: ${name}`);
        res.json({ success: true, role });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { mobile, password } = req.body;
        const user = await User.findOne({ mobile, password: hashPassword(password) });
        if (!user) return res.status(401).json({ error: "Invalid mobile or password" });
        const token = genToken(mobile);
        sessions.set(token, { mobile: user.mobile, role: user.role, name: user.name });
        setTimeout(() => sessions.delete(token), 8 * 60 * 60 * 1000);
        console.log(`🔑 Login: ${user.name} (${user.role})`);
        res.json({ success: true, user: { name: user.name, mobile: user.mobile, role: user.role, token } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Logout
app.post('/api/logout', (req, res) => { if (req.body.token) sessions.delete(req.body.token); res.json({ success: true }); });

// Get records
app.get('/api/records', async (req, res) => {
    try { res.json(await Record.find().lean()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Save record (admin only)
app.post('/api/records', requireAdmin, async (req, res) => {
    try {
        const { name, amount, date, status } = req.body;
        if (!name || !date) return res.status(400).json({ error: "Name and date required" });
        await Record.findOneAndUpdate({ name, date }, { amount: Number(amount) || 500, status: status || 'Pending' }, { upsert: true, returnDocument: 'after' });
        console.log(`📝 ${name} | ${date} | ₹${amount} | ${status}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPENSE ROUTES ──

// Get expenses
app.get('/api/expenses', async (req, res) => {
    try { res.json(await Expense.find().lean()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Add expense (admin only)
app.post('/api/expenses', requireAdmin, async (req, res) => {
    try {
        const { description, amount, date, category } = req.body;
        if (!description || !amount || !date) return res.status(400).json({ error: "All fields required" });
        const exp = await new Expense({ description, amount: Number(amount), date, category: category || 'Other' }).save();
        console.log(`💸 Expense: ${description} | ₹${amount} | ${date}`);
        res.json({ success: true, expense: exp });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete expense (admin only)
app.delete('/api/expenses/:id', requireAdmin, async (req, res) => {
    try {
        await Expense.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Bisht Bros Server → http://localhost:${PORT}`));

