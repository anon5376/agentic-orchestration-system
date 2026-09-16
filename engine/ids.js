import { randomBytes, createHash } from 'node:crypto';

const PREFIX = {
  project: 'prj',
  goal: 'gol',
  run: 'run',
  task: 'tsk',
  agent: 'agt',
  dep: 'dep',
  event: 'evt',
  evidence: 'evd',
  decision: 'dec',
  policy: 'pol',
  retro: 'rtr',
  proposal: 'prp',
  provider: 'prv',
  memory: 'mem',
  setting: 'set',
  capability: 'cap',
  capabilityTest: 'cpt',
  capabilityPermission: 'cpm',
  capabilityState: 'cst',
  capabilityExecution: 'cex',
  effectApproval: 'eap',
  effectClaim: 'efc',
  effectReceipt: 'efr',
  effectRollbackReceipt: 'erb',
  resourceReservation: 'rrs',
  resourceReceipt: 'rrc',
  harnessSession: 'hss',
  improvementEvaluation: 'iev',
  genomeVersion: 'gnm',
  driver: 'drv',
};

export function newId(kind) {
  const prefix = PREFIX[kind] || 'id';
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

export function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function nowIso(clock = () => Date.now()) {
  return new Date(clock()).toISOString();
}
