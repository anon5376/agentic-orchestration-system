import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { createInitialDemoState } from '../data/demoState';

const DemoContext = createContext(null);

const commandResponses = {
  help: [
    'available: help · status · agents · evidence · clear',
    'navigation: open /missions · open /synthesis · open /capabilities',
  ],
  status: [
    'RUN-024  awaiting decision  00:42:18',
    'agents  05 total / 02 active / 01 blocked',
    'evidence  03 findings / 01 conflict / 01 open',
  ],
  agents: [
    'Lead                 active  74%',
    'Source review        active  62%',
    'Adversarial review   blocked 41%',
    'Mechanism analysis   complete',
  ],
  evidence: [
    'F-01 supported  0.78  04 sources',
    'F-02 conflict   0.54  02 sources',
    'F-03 open       0.31  01 source',
  ],
};

export function DemoProvider({ children }) {
  const [state, setState] = useState(createInitialDemoState);

  const setSelectedAgent = useCallback((agentId) => {
    setState((current) => ({
      ...current,
      selectedAgentId: agentId,
      lastAction: `Inspection focus → ${agentId}`,
    }));
  }, []);

  const setFocusedBranch = useCallback((branch) => {
    setState((current) => ({
      ...current,
      focusedBranch: branch,
      lastAction: `Branch focus → ${branch}`,
    }));
  }, []);

  const setActiveFilter = useCallback((filter) => {
    setState((current) => ({
      ...current,
      activeFilter: filter,
      lastAction: `Filter → ${filter}`,
    }));
  }, []);

  const setDecision = useCallback((decision) => {
    setState((current) => ({
      ...current,
      decision,
      lastAction: `Decision simulated → ${decision}`,
    }));
  }, []);

  const setCliOpen = useCallback((open) => {
    setState((current) => ({ ...current, cliOpen: open }));
  }, []);

  const toggleCli = useCallback(() => {
    setState((current) => ({ ...current, cliOpen: !current.cliOpen }));
  }, []);

  const setCliExpanded = useCallback((expanded) => {
    setState((current) => ({ ...current, cliExpanded: expanded }));
  }, []);

  const appendCliLines = useCallback((command, responseLines, { live = false } = {}) => {
    setState((current) => ({
      ...current,
      cliHistory: [...current.cliHistory, command],
      cliLines: [
        ...current.cliLines,
        { kind: 'command', text: command },
        ...responseLines.map((text) => ({ kind: 'output', text })),
      ],
      lastAction: live ? `Live CLI → ${command}` : `CLI command → ${command}`,
    }));
  }, []);

  const runCliCommand = useCallback((rawCommand) => {
    const command = String(rawCommand || '').trim();
    if (!command) return;
    const key = command.toLowerCase();

    setState((current) => {
      if (key === 'clear') {
        return {
          ...current,
          cliHistory: [...current.cliHistory, command],
          cliLines: [{ kind: 'system', text: 'output cleared — simulated state retained' }],
          lastAction: 'CLI output cleared',
        };
      }

      const response = commandResponses[key] || [
        `demo only: “${command}” was recorded without execution`,
        'no provider, filesystem, or network action was performed',
      ];
      const prompt = { kind: 'command', text: command };
      const lines = response.map((text) => ({ kind: 'output', text }));
      return {
        ...current,
        cliHistory: [...current.cliHistory, command],
        cliLines: [...current.cliLines, prompt, ...lines],
        lastAction: `CLI command → ${command}`,
      };
    });
  }, []);

  const value = useMemo(
    () => ({
      state,
      setSelectedAgent,
      setFocusedBranch,
      setActiveFilter,
      setDecision,
      setCliOpen,
      toggleCli,
      setCliExpanded,
      runCliCommand,
      appendCliLines,
    }),
    [
      state,
      setSelectedAgent,
      setFocusedBranch,
      setActiveFilter,
      setDecision,
      setCliOpen,
      toggleCli,
      setCliExpanded,
      runCliCommand,
      appendCliLines,
    ],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemoState() {
  const context = useContext(DemoContext);
  if (!context) throw new Error('useDemoState must be used inside DemoProvider');
  return context;
}
