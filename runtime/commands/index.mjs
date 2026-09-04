// The command registry.
//
// Two things read this. The dispatcher loads exactly one group module per
// invocation, so a single command still pays for only its own dependencies.
// And the help text is GENERATED from it rather than hand-written.
//
// That second part is the point. The help string used to be maintained by hand
// beside a 46-branch if/else chain, and it had already drifted: three
// implemented `task` subcommands were missing from it. Help text is the only
// discovery surface an agent has for this CLI, so a missing entry is a
// capability the model never learns it can use. Generating the text removes
// that failure mode instead of testing for it, and
// scripts/validate-cli-surface.mjs checks this table against the handlers that
// actually exist rather than against a regex over source.

const GROUPS={
  project:()=>import("./project.mjs"),
  run:()=>import("./run.mjs"),
  artifacts:()=>import("./artifacts.mjs"),
  tools:()=>import("./tools.mjs"),
  provider:()=>import("./provider.mjs"),
  activation:()=>import("./activation.mjs"),
  design:()=>import("./design.mjs"),
  task:()=>import("./task.mjs"),
  repo:()=>import("./repo.mjs"),
  feature:()=>import("./feature.mjs"),
  delivery:()=>import("./delivery.mjs"),
  completion:()=>import("./completion.mjs"),
  dashboard:()=>import("./dashboard.mjs"),
  auto:()=>import("./auto.mjs")
};

/** Command name -> its group, and the subcommands it dispatches.
 *  Insertion order is the order the old dispatcher tested its branches in, and
 *  it is the order the generated help lists commands in. */
export const COMMANDS={
  init:{group:"project"},
  route:{group:"run"},
  start:{group:"run"},
  status:{group:"run"},
  explain:{group:"run"},
  diff:{group:"run"},
  next:{group:"run"},
  transition:{group:"run"},
  approval:{group:"run",subcommands:["status","tickets","request","grant-ticket","grant","revoke"]},
  gate:{group:"run",subcommands:["status","explain"]},
  knowledge:{group:"project",subcommands:["status"]},
  context:{group:"run"},
  "artifact-put":{group:"artifacts"},
  normalize:{group:"artifacts"},
  "artifact-get":{group:"artifacts"},
  "artifact-list":{group:"artifacts"},
  "tool-check":{group:"tools"},
  "tool-run":{group:"tools"},
  "usage-add":{group:"tools"},
  "usage-report":{group:"tools"},
  "config-show":{group:"project"},
  "compat-check":{group:"project"},
  migrate:{group:"project"},
  "parallel-plan":{group:"run"},
  metrics:{group:"run"},
  "handoff-put":{group:"artifacts"},
  "handoff-get":{group:"artifacts"},
  "handoff-list":{group:"artifacts"},
  "model-route":{group:"tools"},
  "provider-probe":{group:"provider"},
  "provider-command":{group:"provider"},
  "provider-run":{group:"provider"},
  "replay-export":{group:"artifacts"},
  "replay-validate":{group:"artifacts"},
  activation:{group:"activation",subcommands:["status","print-bootstrap","policy","cost","enable","disable","classify","events","record","doctor","codex-bootstrap","install","uninstall"]},
  design:{group:"design",subcommands:["mode","policy","validate","scaffold","record"]},
  plan:{group:"design",subcommands:["validate","graph","record"]},
  task:{group:"task",subcommands:["list","show","graph","events","progress","state-machine","materialize","migrate","refresh","ready","schedule","transition","context","context-show","start","capture","verify","review","advance","checkpoint","usage-add","usage","metrics","workspaces","workspace-clean","failure-policy","classify","replay","fallback","resume","implementation-complete"]},
  repo:{group:"repo",subcommands:["index","status","capability","symbol","references","tests","impact","impacted-tests","module","dependents","interfaces","entities","events","recent","surface","mutate","dead-code"]},
  trace:{group:"repo",subcommands:["build","show","kinds","validate","coverage","closure","invalidate","history"]},
  feature:{group:"feature",subcommands:["create","show","list","active","update","phase-create","phase-show","phase-list","phase-complete"]},
  "requirement-update":{group:"feature",subcommands:["plan","show"]},
  delivery:{group:"delivery",subcommands:["status","targets","branch","push-check","drift","group","record","pr-body","changelog"]},
  ci:{group:"delivery",subcommands:["record","status","show","history","verify-chain","quarantine"]},
  govern:{group:"delivery",subcommands:["policy","report","complexity","task","boundaries","simulate"]},
  fallback:{group:"provider"},
  learn:{group:"delivery",subcommands:["sources","candidate"]},
  review:{group:"delivery",subcommands:["audit"]},
  doctor:{group:"project"},
  gc:{group:"project",subcommands:["status","apply"]},
  completion:{group:"completion"},
  dashboard:{group:"dashboard"},
  serve:{group:"dashboard"},
  rewind:{group:"run"},
  webhook:{group:"project",subcommands:["list","test"]},
  auto:{group:"auto"},
  "auto-task":{group:"auto"},
  "ci-check":{group:"auto"}
};

export const COMMAND_NAMES=Object.keys(COMMANDS);
export const GROUP_NAMES=Object.keys(GROUPS);

/** Load one group module. Exported so the surface validator can compare the
 *  table above against the handlers a group really exports. */
export function loadGroup(name){
  const loader=GROUPS[name];
  if(!loader)throw new Error(`unknown command group ${name}`);
  return loader();
}

/** The handler for a command, or null if the name is not a command. */
export async function loadCommand(name){
  const entry=COMMANDS[name];
  if(!entry)return null;
  const mod=await loadGroup(entry.group);
  return mod.commands[name]||null;
}

/** Flags that change what `start` does; they have no subcommand to list. */
const START_FLAGS=[
  "--objective","--workflow","--profile","--feature-id","--phase-id","--feature-title",
  "--track-feature (auto-create a feature for a plain new-feature start)",
  "--parent-run-id","--run-kind","--semantic (model-assisted semantic classification)"
];

/** The help text, derived from the table above so it cannot drift from it. */
export function renderHelp(version){
  const subLines=COMMAND_NAMES
    .filter(c=>COMMANDS[c].subcommands?.length)
    .map(c=>`${c} subcommands: ${COMMANDS[c].subcommands.join(", ")}`);
  return [
    `agent-sdlc ${version}`,
    "",
    `Commands: ${COMMAND_NAMES.join(", ")}`,
    "",
    subLines.join("\n"),
    "",
    `start flags: ${START_FLAGS.join(", ")}`
  ].join("\n");
}
