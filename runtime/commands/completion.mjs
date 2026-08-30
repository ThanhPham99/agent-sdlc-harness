// Shell completion generator for Agent SDLC CLI.
import {COMMANDS,COMMAND_NAMES} from './index.mjs';

function generateBashCompletion(){
  const cmds=COMMAND_NAMES.join(' ');
  const subcases=Object.entries(COMMANDS)
    .filter(([_,c])=>c.subcommands?.length)
    .map(([name,c])=>`      ${name}) COMPREPLY=($(compgen -W "${c.subcommands.join(' ')}" -- "$cur")) ;;`)
    .join('\n');
  return `_agent_sdlc() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${cmds}" -- "$cur"))
    return 0
  fi

  case "$prev" in
${subcases}
    *) ;;
  esac
}
complete -F _agent_sdlc agent-sdlc
`;
}

function generateZshCompletion(){
  return `#compdef agent-sdlc
_agent_sdlc() {
  local -a commands
  commands=(${COMMAND_NAMES.map(c=>`'${c}'`).join(' ')})
  _describe 'command' commands
}
_agent_sdlc "$@"
`;
}

function generatePowershellCompletion(){
  const cmds=COMMAND_NAMES.map(c=>`'${c}'`).join(',');
  return `Register-ArgumentCompleter -Native -CommandName 'agent-sdlc','bin/agent-sdlc' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(${cmds})
  $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

function generateFishCompletion(){
  const cmds=COMMAND_NAMES.join(' ');
  return `# Fish completion for agent-sdlc
complete -c agent-sdlc -f
complete -c agent-sdlc -n "__fish_use_subcommand" -a "${cmds}"
`;
}

export const commands={
  completion:async ctx=>{
    const {args,print}=ctx;
    const shell=String(args._[1]||args.shell||'bash').toLowerCase();
    if(shell==='bash')print(generateBashCompletion());
    else if(shell==='zsh')print(generateZshCompletion());
    else if(shell==='pwsh'||shell==='powershell')print(generatePowershellCompletion());
    else throw new Error(`unsupported shell "${shell}"; use bash, zsh, or pwsh`);
  }
};
