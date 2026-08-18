const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db/database');
const { logAction } = require('../db/audit');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
    .get((username || '').trim());

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: 'Invalid username or password.' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    company_id: user.company_id,
    branch_id: user.branch_id,
  };
  logAction(user.id, 'LOGIN', 'user', user.id, `${user.username} logged in`);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  const user = req.session.user;
  if (user) logAction(user.id, 'LOGOUT', 'user', user.id, `${user.username} logged out`);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
