import React from 'react';
import { StatusSignal } from './StatusSignal';

export function PrototypeState({ label = 'ILLUSTRATIVE / DEMO STATE' }) {
  return <StatusSignal status="prototype" label={label} compact />;
}
