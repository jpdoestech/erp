// All authorization is enforced here, server-side — never trust the UI alone,
// and never trust query/body params for scope on non-super-admin users.

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        message: 'You do not have permission to perform this action.',
      });
    }
    next();
  };
}

// Returns the company_id a request is allowed to operate on.
// SUPER_ADMIN may pick any company via ?company_id= (or body company_id for POSTs).
// Every other role is locked server-side to their own assigned company_id,
// regardless of what a client sends.
function getScopedCompanyId(req) {
  const user = req.session.user;
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') {
    const raw = req.query.company_id || req.body.company_id;
    return raw ? Number(raw) : null;
  }
  return user.company_id;
}

// Verifies a record's company_id matches the caller's allowed scope.
// Use this after loading any record by id, before returning/mutating it.
function assertCompanyScope(req, recordCompanyId) {
  const user = req.session.user;
  if (user.role === 'SUPER_ADMIN') return true;
  return Number(recordCompanyId) === Number(user.company_id);
}

module.exports = { requireLogin, requireRole, getScopedCompanyId, assertCompanyScope };
