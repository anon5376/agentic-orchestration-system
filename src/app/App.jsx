import React, { useEffect, useState } from 'react';
import { useHashRouter } from './router';
import { useDemoState } from './DemoContext';
import { useWorkspace } from './WorkspaceContext';
import { GlobalRail } from '../components/GlobalRail';
import { CommandPalette } from '../components/CommandPalette';
import { CLIDrawer } from '../components/CLIDrawer';
import { ModeBanner } from '../components/ModeBanner';
import { routeDefinitions } from '../data/demoState';
import {
  MissionsPage,
  IntakePage,
  SwarmPage,
  EvidencePage,
  SynthesisPage,
  EvolutionPage,
  CapabilitiesPage,
  MemoryPage,
} from '../pages/DocketPages';
import {
  LiveMissionsPage,
  LiveIntakePage,
  LiveSwarmPage,
  LiveEvidencePage,
  LiveSynthesisPage,
  LiveEvolutionPage,
  LiveCapabilitiesPage,
  LiveMemoryPage,
} from '../pages/LivePages';
import { SystemPage } from '../pages/SystemPage';

const illustrativePages = {
  missions: MissionsPage,
  intake: IntakePage,
  swarm: SwarmPage,
  evidence: EvidencePage,
  synthesis: SynthesisPage,
  evolution: EvolutionPage,
  capabilities: CapabilitiesPage,
  memory: MemoryPage,
  system: SystemPage,
};

const livePages = {
  missions: LiveMissionsPage,
  intake: LiveIntakePage,
  swarm: LiveSwarmPage,
  evidence: LiveEvidencePage,
  synthesis: LiveSynthesisPage,
  evolution: LiveEvolutionPage,
  capabilities: LiveCapabilitiesPage,
  memory: LiveMemoryPage,
  system: SystemPage,
};

export default function App() {
  const { path, route, navigate } = useHashRouter();
  const demo = useDemoState();
  const workspace = useWorkspace();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pages = workspace.mode === 'live' ? livePages : illustrativePages;
  const Page = pages[route.key] || pages.missions;

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if ((event.ctrlKey || event.metaKey) && event.key === '`') {
        event.preventDefault();
        demo.toggleCli();
      } else if (event.key === 'Escape' && demo.state.cliOpen && !paletteOpen) {
        demo.setCliOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [demo, paletteOpen]);

  useEffect(() => {
    document.title = `AOS / ${route.label}`;
  }, [route.label]);

  const handleNavigate = (nextPath) => {
    navigate(nextPath);
    setPaletteOpen(false);
    document.getElementById('main-content')?.focus({ preventScroll: true });
  };

  const handleCliCommand = async (command) => {
    const openTarget = command.match(/^open\s+(.+)$/i)?.[1]?.trim();
    if (openTarget) {
      const target = routeDefinitions.find(
        (candidate) =>
          candidate.path === (openTarget.startsWith('/') ? openTarget : `/${openTarget}`) ||
          candidate.key === openTarget.toLowerCase() ||
          candidate.label.toLowerCase() === openTarget.toLowerCase(),
      );
      if (target) navigate(target.path);
    }
    if (workspace.mode === 'live') {
      try {
        const result = await workspace.runCli(command);
        demo.appendCliLines(command, result.lines || [], { live: true });
      } catch (error) {
        demo.appendCliLines(command, [`error: ${error.message}`], { live: true });
      }
      return;
    }
    demo.runCliCommand(command);
  };

  return (
    <div className="aos-app" data-route={route.key} data-cli-open={demo.state.cliOpen} data-mode={workspace.mode}>
      <GlobalRail
        route={route}
        path={path}
        onNavigate={handleNavigate}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleCli={demo.toggleCli}
        cliOpen={demo.state.cliOpen}
        run={workspace.mode === 'live' ? workspace.snapshot?.run || { id: 'NO-RUN', status: workspace.connection } : demo.state.run}
      />
      <ModeBanner />

      <main id="main-content" className="aos-main" tabIndex="-1">
        <Page onNavigate={handleNavigate} />
      </main>

      <CLIDrawer
        open={demo.state.cliOpen}
        expanded={demo.state.cliExpanded}
        lines={demo.state.cliLines}
        live={workspace.mode === 'live'}
        route={route}
        run={workspace.mode === 'live' ? workspace.snapshot?.run : demo.state.run}
        connection={workspace.connection}
        onClose={() => demo.setCliOpen(false)}
        onOpen={() => demo.setCliOpen(true)}
        onToggleExpanded={() => demo.setCliExpanded(!demo.state.cliExpanded)}
        onCommand={handleCliCommand}
      />

      <CommandPalette
        open={paletteOpen}
        currentPath={path}
        onClose={() => setPaletteOpen(false)}
        onNavigate={handleNavigate}
        onToggleCli={() => {
          demo.toggleCli();
          setPaletteOpen(false);
        }}
      />
    </div>
  );
}
