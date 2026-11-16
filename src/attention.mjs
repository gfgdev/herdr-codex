// Persistent observations of work, not an interpretation of an agent's prose.
export const stateOf = terminal => terminal?.status?.state ?? terminal?.status ?? null;
const settled = state => state === 'done' || state === 'idle';
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function observe(previous, terminal, { event, activation, now = new Date().toISOString() } = {}) {
  const state = stateOf(terminal), turn = counter(terminal.turn);
  const edge = event?.type === 'status' ? stateOf({ status: event.data?.status })
    : event?.type === 'turn' ? event.data?.state : null;
  // RPC snapshots can run ahead of queued events. An old working edge must not
  // reopen a turn already observed as settled. A genuinely new fast turn is
  // recovered by its next counter increment or a live working snapshot.
  const workingEdge = edge === 'working' && !(settled(state) && previous?.settledThroughTurn >= turn);
  const currentWorking = state === 'working';
  const activationIsNew = activation && activation.id !== previous?.activationId;
  const awaitingIncrement = Boolean(previous?.endNeedsIncrement && turn > previous.turn);
  const activationBaseline = Math.max(counter(activation?.baselineTurn),
    previous?.deferredActivationId === activation?.id ? counter(previous?.deferredActivationTurn) : 0);
  const deliveredTurnEnded = activationIsNew && !awaitingIncrement && turn > activationBaseline;
  const unseenTurn = previous && turn > previous.turn && !awaitingIncrement;
  const begins = !previous?.working && (workingEdge || currentWorking || deliveredTurnEnded || (unseenTurn && settled(state)));
  const observation = { ...previous, turn, state, pid: terminal.pid ?? null,
    episode: previous?.episode ?? 0, working: currentWorking, observedAt: now };
  if (awaitingIncrement) observation.endNeedsIncrement = false;
  if (awaitingIncrement && activationIsNew && !workingEdge && !currentWorking) {
    observation.deferredActivationId = activation.id;
    observation.deferredActivationTurn = turn;
  }
  if (begins) {
    observation.episode++;
    observation.startTurn = activationIsNew ? activationBaseline
      : previous ? previous.turn : Math.max(0, turn - (currentWorking ? 0 : 1));
    observation.startedAt = now;
    // Send time is a trustworthy lower bound; processing time is not, because
    // a report can be archived before delayed status events arrive.
    observation.notBefore = activationIsNew && Number.isFinite(Date.parse(activation.at)) ? activation.at
      : currentWorking && Number.isFinite(terminal.status_ms) ? new Date(terminal.status_ms).toISOString() : null;
    observation.coveredReports = (previous?.coveredReports ?? []).filter(report => report.turn >= observation.startTurn);
    observation.pending = null;
    observation.endNeedsIncrement = false;
  }
  if (activationIsNew && (begins || currentWorking || previous?.working)) observation.activationId = activation.id;
  if (settled(state) && (previous?.working || begins)) {
    observation.settledEpisode = observation.episode;
    observation.endNeedsIncrement = turn <= observation.startTurn;
    observation.pending = { episode: observation.episode, startTurn: observation.startTurn,
      turn, endedAt: now, notBefore: observation.notBefore };
    observation.settledThroughTurn = turn;
  } else if (observation.pending && turn > observation.pending.turn) {
    observation.pending = { ...observation.pending, turn };
  }
  if (awaitingIncrement && settled(state)) observation.settledThroughTurn = turn;
  // A blocked/error state is handled immediately as its own incident.
  if (!settled(state) && !currentWorking) observation.pending = null;
  return observation;
}

export function coveredByMessage(observation, message, workerId) {
  const p = observation?.pending;
  return Boolean(p && message.workerId === workerId && ['question','result'].includes(message.kind) &&
    !(observation.coveredReports ?? []).some(report => report.id === message.id) &&
    (!p.notBefore || Date.parse(message.createdAt) >= Date.parse(p.notBefore)) &&
    Number.isSafeInteger(message.turn) && message.turn >= p.startTurn && message.turn <= p.turn);
}

export function consume(observation, reason) {
  const coveredReports = [...(observation.coveredReports ?? [])];
  if (reason.startsWith('report:') && observation.pending && !coveredReports.some(r => r.id === reason.slice(7))) {
    coveredReports.push({ id: reason.slice(7), turn: observation.pending.turn });
  }
  return { ...observation, handledEpisode: observation.pending?.episode ?? observation.handledEpisode,
    handledReason: reason, coveredReports, pending: null };
}
