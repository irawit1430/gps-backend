// Makes "sign this user out everywhere" survive a restart.
//
// middleware/auth.js keeps each user's revocation cutoff in memory. On its own, a PM2
// restart or deploy forgot every cutoff, so a token revoked by a password change, an
// admin reset, or a role or school change worked again until it expired (24h).
//
// Each cutoff is now also written to User.tokensValidAfter, and read back before the
// server accepts connections. It is the same cutoff, in whole seconds, so a restored
// one refuses exactly the tokens the original did, and the replacement token that
// change-password hands out (dated a second later) keeps working.
//
// Not covered: a deleted user has no row to write to, so their cutoff still lasts only
// until restart; and a single-device logout stays in memory (the app deletes that
// token itself).

const { onUserRevoked, restoreRevocations } = require('./middleware/auth');

function persistRevocations(prisma, logger) {
  return onUserRevoked((userId, cutoff) => {
    const at = new Date(cutoff * 1000);
    // Promise.resolve() first so nothing here can throw into the request that revoked.
    Promise.resolve()
      .then(() =>
        prisma.user.updateMany({
          // Never move a saved cutoff earlier, whatever order two writes land in.
          where: { id: userId, OR: [{ tokensValidAfter: null }, { tokensValidAfter: { lt: at } }] },
          data: { tokensValidAfter: at },
        })
      )
      .catch((err) => {
        logger.error({ err, userId }, 'Could not save session revocation; it holds only until restart');
      });
  });
}

async function loadRevocations(prisma) {
  const rows = await prisma.user.findMany({
    where: { tokensValidAfter: { not: null } },
    select: { id: true, tokensValidAfter: true },
  });
  restoreRevocations(rows.map((r) => [r.id, Math.floor(r.tokensValidAfter.getTime() / 1000)]));
  return rows.length;
}

module.exports = { persistRevocations, loadRevocations };
