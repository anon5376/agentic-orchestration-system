import React from 'react';

const plateMeta = {
  missions: ['01', 'PARALLEL INQUIRIES'],
  intake: ['02', 'QUESTION / SCOPE'],
  swarm: ['03', 'DIVISION OF WORK'],
  evidence: ['04', 'SOURCE LINEAGE'],
  synthesis: ['05', 'CONVERGENCE / DISSENT'],
  evolution: ['06', 'CHANGE UNDER REVIEW'],
  capabilities: ['07', 'AVAILABLE PATHS'],
  memory: ['08', 'BOUNDED RETENTION'],
};

function PlateDrawing({ variant }) {
  if (variant === 'missions') {
    return <><path d="M76 58h74l24 20h64l27-20h85l25 20h68M76 118h91l27-22h87l31 22h131M76 178h58l28-26h74l26 26h181"/><circle cx="76" cy="58" r="7"/><circle cx="443" cy="78" r="7"/><circle cx="76" cy="118" r="7"/><circle cx="443" cy="118" r="7"/><circle cx="76" cy="178" r="7"/><circle cx="443" cy="178" r="7"/><text x="92" y="48">ADAPTIVE INTERFACES</text><text x="92" y="108">MACHINE MEMORY</text><text x="92" y="168">AGENT ECOLOGIES</text></>;
  }
  if (variant === 'intake') {
    return <><circle cx="346" cy="118" r="78"/><circle cx="346" cy="118" r="17"/><path d="M58 38C164 38 204 70 329 110M58 82C180 82 242 96 329 115M58 130C178 130 244 126 329 120M58 180C160 180 214 151 329 126"/><path d="M346 23v190M251 118h190"/></>;
  }
  if (variant === 'swarm') {
    return <><circle cx="126" cy="116" r="16"/><circle cx="257" cy="57" r="11"/><circle cx="257" cy="116" r="11"/><circle cx="257" cy="175" r="11"/><circle cx="405" cy="35" r="7"/><circle cx="405" cy="79" r="7"/><circle cx="405" cy="116" r="7"/><circle cx="405" cy="160" r="7"/><circle cx="405" cy="204" r="7"/><path d="M142 110C191 96 202 64 246 58M142 116h104M142 122C191 136 202 169 246 174M268 53l130-18M268 61l130 17M268 116h130M268 171l130-11M268 179l130 25"/></>;
  }
  if (variant === 'evidence') {
    return <><path d="M74 49h302M105 73h339M61 98h258M92 122h370M68 147h292M122 171h327M79 196h260"/><path d="M96 38v168M179 38v168M285 38v168M389 38v168"/><circle cx="179" cy="98" r="13"/><circle cx="389" cy="147" r="13"/><path d="M166 98h-43M192 98h93M376 147h-91M402 147h45"/><text x="108" y="92">S-18</text><text x="400" y="141">S-11</text></>;
  }
  if (variant === 'synthesis') {
    return <><path d="M248 25C151 25 79 65 79 118s72 93 169 93M272 25c97 0 169 40 169 93s-72 93-169 93"/><path d="M248 25c-59 24-91 55-91 93s32 69 91 93M272 25c59 24 91 55 91 93s-32 69-91 93"/><path d="M260 13v210M205 118h110"/><circle cx="260" cy="118" r="12"/></>;
  }
  if (variant === 'evolution') {
    return <><text x="56" y="47">BASELINE / 428 STEPS</text><text x="56" y="146">CANDIDATE / 391 STEPS</text><path d="M56 76h54l17-25 31 66 24-42 31 14 26-38 33 66 24-42 30 13 26-37 31 66 29-41h56"/><path d="M56 166h54l17-18 31 40 24-25 31 9 26-23 33 39 24-25 30 8 26-22 31 39 29-22h56"/><path d="M56 121h422"/><circle cx="272" cy="117" r="17"/><path d="M272 31v172"/></>;
  }
  if (variant === 'capabilities') {
    return <><circle cx="92" cy="63" r="13"/><circle cx="92" cy="118" r="13"/><circle cx="92" cy="173" r="13"/><circle cx="426" cy="47" r="10"/><circle cx="426" cy="91" r="10"/><circle cx="426" cy="135" r="10"/><circle cx="426" cy="179" r="10"/><path d="M105 63h72c42 0 43 55 85 55h151M105 118h308M105 173h72c42 0 43-82 85-82h151M262 91v44"/><path d="M161 42v152M363 27v172"/><text x="58" y="43">WORKERS</text><text x="397" y="27">TOOLS</text></>;
  }
  return <><rect x="82" y="37" width="326" height="148"/><rect x="104" y="54" width="326" height="148"/><rect x="126" y="71" width="326" height="148"/><path d="M126 97h326M126 123h326M126 149h326M126 175h326"/><circle cx="329" cy="145" r="40"/><circle cx="329" cy="145" r="20"/></>;
}

export function DocketFigure({ variant }) {
  const [number, label] = plateMeta[variant] || plateMeta.memory;

  return (
    <figure className="docket-figure" aria-hidden="true">
      <span className="docket-figure__index">{number}</span>
      <svg viewBox="0 0 520 250" role="img">
        <g className="docket-figure__drawing"><PlateDrawing variant={variant} /></g>
        <g className="docket-figure__ticks">
          <path d="M12 26h28M26 12v28M480 212h28M494 198v28" />
          <path d="M27 229h124M368 22h124" strokeDasharray="3 6" />
        </g>
        <text x="28" y="246">AOS / PLATE {number}</text>
        <text x="492" y="246" textAnchor="end">{label}</text>
      </svg>
    </figure>
  );
}
