const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAY_BASE_MS = 250;

/**
 * Run the bounded replay recovery path shared by stream errors and aos.resync.
 * The caller owns the attempt counter; this function only chooses the next
 * transport action after replay settles.
 */
export async function recoverTransport({
  replay,
  status,
  attempts = 0,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  delayBaseMs = DEFAULT_DELAY_BASE_MS,
  isActive = () => true,
  scheduleReconnect,
  startPolling,
}) {
  if (!isActive()) return { attempts, recovered: false, action: 'disposed' };

  if (attempts >= maxAttempts) {
    startPolling();
    return { attempts, recovered: false, action: 'polling' };
  }

  const nextAttempts = attempts + 1;
  let recovered = false;
  try {
    recovered = Boolean(await replay(status));
  } catch {
    recovered = false;
  }

  if (!isActive()) return { attempts: nextAttempts, recovered, action: 'disposed' };

  const delayMs = delayBaseMs * (2 ** (nextAttempts - 1));
  if (!recovered && nextAttempts >= maxAttempts) {
    startPolling();
    return { attempts: nextAttempts, recovered, action: 'polling' };
  }

  scheduleReconnect(delayMs);
  return { attempts: nextAttempts, recovered, action: 'reconnect' };
}

export function createTransportRecovery({
  replay,
  scheduleReconnect,
  startPolling,
  isActive = () => true,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  delayBaseMs = DEFAULT_DELAY_BASE_MS,
}) {
  let attempts = 0;
  let inFlight = null;

  const recover = (status) => {
    if (!isActive()) return Promise.resolve({ attempts, recovered: false, action: 'disposed' });
    if (inFlight) return inFlight;

    const pending = recoverTransport({
      replay,
      status,
      attempts,
      maxAttempts,
      delayBaseMs,
      isActive,
      scheduleReconnect,
      startPolling,
    }).then((result) => {
      if (isActive()) attempts = result.attempts;
      return result;
    });
    let wrapped;
    wrapped = pending.finally(() => {
      if (inFlight === wrapped) inFlight = null;
    });
    inFlight = wrapped;
    return wrapped;
  };

  return {
    recover,
    resetAttempts: () => { attempts = 0; },
  };
}
