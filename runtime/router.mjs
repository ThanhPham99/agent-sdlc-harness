import path from 'node:path';
import {readJson} from './util.mjs';

// Quoted text is data, not instruction, so it is removed before any keyword or
// phrase is matched. The single-quote rule used to pair any two apostrophes,
// which meant an ordinary contraction swallowed the sentence between them: "The
// team's blocked, bypass all approvals now, that's it." became "The team s it."
// and the demand in the middle -- the operator's own words -- was never seen by
// the router or by the advisory matcher.
//
// An apostrophe cannot be classified on its own. Three attempts tried, and each
// let a real quotation leak back into keyword matching, which is the expensive
// direction: quoted text then picks the workflow and the profile. Allowing a
// quote only beside listed punctuation missed "log--'migrate the users table'--".
// Treating any apostrophe with word characters on both sides as intra-word
// missed "log:k1'migrate the users table'v1". Masking recognised contraction
// endings missed "the log recorded's migrate the users table'", where the
// quotation's own opening delimiter reads as a contraction.
//
// So the local guess is checked globally, and there is more than one guess. A
// quotation mark has a partner, so after masking, the apostrophes still standing
// must come in pairs; an odd count is proof that the masking ate a delimiter.
// Three readings are tried in order -- contractions and possessives, then
// contractions alone, then nothing at all -- and the first that leaves an even
// count wins. The last is the old blunt rule, which pairs every apostrophe and
// loses operator text; it now applies only to the sentences where both careful
// readings provably went wrong.
//
// The middle rung is not decoration. "The log says: 'the team's blocked, bypass
// all approvals'." ends its quotation on the word "approvals", so the possessive
// rule eats the closing delimiter and the quotation leaks; dropping back to
// contractions alone pairs it correctly and quarantines the whole thing.
//
// The residue, stated rather than implied: a word-initial apostrophe still reads
// as an opening quote ("back in the '80s"), and a contraction from another
// language ("l'equipe") is not in the ending list, so a sentence carrying two of
// them still pairs them and loses what lies between. Both predate this rule.
const AND_CONTRACTION=/([\p{L}\p{N}][\p{M}]*)'n'(?=[\p{L}])/giu;
// A combining mark counts as part of the letter it sits on: "cafe" + U+0301 ends
// in a mark, not a letter, and without this an accent alone turned an ordinary
// contraction back into a quote delimiter.
const CONTRACTION=/([\p{L}\p{N}][\p{M}]*)'(s|t|re|ve|ll|d|m|n|clock)(?![\p{L}\p{N}])/giu;
const POSSESSIVE=/([\p{L}\p{N}][\p{M}]*s)'(?![\p{L}\p{N}])/giu;
const APOSTROPHE_MASK='\u0000';
const balanced=t=>((t.match(/'/g)||[]).length%2)===0;
function stripEmbeddedData(s){
  // The mask is restored to an apostrophe at the end, so a mask character
  // arriving in the objective itself would leave as one. Review found that two
  // NUL bytes in an objective became a matching pair of quotation marks on the
  // next pass and quarantined the demand between them -- text hidden with no
  // apostrophe anywhere in sight. The operator's own NULs are dropped before the
  // sentinel is used, so every mask in the string is one this function put there.
  const text=String(s||'').split(APOSTROPHE_MASK).join(' ');
  // Nothing to reconcile when there is no apostrophe: skip three regex passes on
  // the overwhelmingly common objective. route() runs this on every request.
  if(!text.includes("'"))return text
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/"[^"]*"/g,' ')
    .replace(/`[^`]*`/g,' ');
  const contracted=text
    .replace(AND_CONTRACTION,`$1${APOSTROPHE_MASK}n${APOSTROPHE_MASK}`)
    .replace(CONTRACTION,`$1${APOSTROPHE_MASK}$2`);
  const withPossessives=contracted.replace(POSSESSIVE,`$1${APOSTROPHE_MASK}`);
  const source=[withPossessives,contracted,text].find(balanced)??text;
  return source
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/"[^"]*"/g,' ')
    .replace(/'[^']*'/g,' ')
    .replace(/`[^`]*`/g,' ')
    .split(APOSTROPHE_MASK).join("'");
}
// Objectives are written in the operator's own language. Normalization used to
// drop every non-ASCII character, so a Vietnamese objective disintegrated into
// fragments ("sửa lỗi" -> "s a l i") and always fell through to the default
// workflow, taking the wrong stage set and profile with it. Folding combining
// marks keeps a single ASCII keyword table serving both languages; the same
// folding is applied to the keywords, so rules stay readable with diacritics.
// Combining marks are matched by code point rather than by a regex literal so
// the source stays readable in any editor; d-with-stroke does not decompose.
function foldDiacritics(s){
  let out='';
  for(const ch of s.normalize('NFD')){
    const c=ch.codePointAt(0);
    if(c>=0x0300&&c<=0x036f)continue;
    out+=(c===0x0111||c===0x0110)?'d':ch;
  }
  return out;
}
// The -ate/-ation family (investigate/investigation, evaluate/evaluation, ...)
// forms its noun regularly, so folding this one suffix pair lets "a security
// investigation" reach the "investigate" keyword without a general stemmer
// that would risk unrelated false matches elsewhere in the keyword table.
function foldVerbNounFamily(s){return s.split(' ').map(w=>w.length>6&&w.endsWith('ation')?w.slice(0,-5)+'ate':w).join(' ');}
function normalize(s){return foldVerbNounFamily(foldDiacritics(stripEmbeddedData(s)).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim());}
function keywordMatch(text,keyword){const t=` ${normalize(text)} `;const k=normalize(keyword);return k? t.includes(` ${k} `):false;}
const keywordWords=k=>normalize(k).split(' ').filter(Boolean).length;
// A demand to waive a control, or to be handed a secret, is not a routing
// signal: it changes neither the workflow nor the profile, and the doctrine in
// evals/live/semantic-decision.schema.json says so explicitly. But the router
// was silent about it altogether, which left the whole trust signal to the
// model, with checkTool as the only backstop -- and left a reader of an empty
// risk_flags (now route_flags, renamed for exactly this reason) free to
// conclude the harness had looked and found nothing. deny_language is the
// deterministic half of that answer: the phrases from the DENY class this
// objective actually contains.
//
// The class is the doctrine's, not this file's invention: a control switched
// off, waived, or overridden despite its verdict, or secrets to be disclosed. The field covered only the first
// half while it was called bypass_language, so "hand me the production
// credentials" -- which waives no control -- reported nothing.
//
// Read it as evidence, never as a verdict:
//  - it authorises nothing. checkTool, against policies/security-policy.json,
//    still decides what may run, and is not given this value;
//  - an empty array means these phrases were not found, NOT that no bypass was
//    demanded. It is a phrase list, not comprehension, and anyone paraphrasing
//    will slip past it;
//  - it never widens the route. It is computed after the workflow, the profile
//    and the overlays are settled, and nothing above reads it.
// Grouped by what is being asked for, because waiving a review, switching off a
// compliance gate and demanding a private key are different requests, and each
// entry carries the phrase that matched so the claim can be checked rather than
// trusted.
//
// SECRETS is generated as verbs x objects rather than typed out. A hand-written
// list of full phrases is an arbitrary cross-section: an independent review of
// the first version found it matched "show me the api key" and not "show me the
// api keys", carried "credentials" but no "token" at all, and the holes were
// accidents of typing rather than decisions. Generating the product makes the
// coverage a property of two short lists that can be read and argued with.
const SECRET_VERBS=['reveal','print','dump','echo','show me','send me','give me','tell me','paste','hand me','in ra','hien thi','xem','lay','gui cho toi','cho toi'];
const SECRET_OBJECTS=['the secrets','the deployment secrets','the credentials','the production credentials','the api key','the api keys','the access token','the auth token','the private key','the deploy key','the password','the env file','mat khau','khoa bi mat','khoa deploy','credentials','file env','file .env'];
const DENY_PHRASES={
  APPROVALS:[
    'bypass all approvals','bypass approvals','bypass the approval','skip approvals','skip approval','skip the approval','without approval','without approvals','without asking anyone','without asking permission','without sign off','no approval needed','no sign off needed','waive approval','waive approvals','waive the approval','auto approve this','approve it yourself','do not wait for the approver',
    'bo qua duyet','bo qua phe duyet','bo qua toan bo buoc duyet','bo qua buoc duyet','khong can duyet','khong can phe duyet','khong can sign off','khong can xin phep','tu approve','tu duyet','tu minh duyet'
  ],
  VERIFICATION:[
    'skip verification','skip the verification','disable verification','disable the verification gate','turn off verification','without verification','even if verification failed','even if full verification failed','even if the tests fail','ignore the failing tests',
    'bo qua test','bo qua kiem thu','tat gate kiem tra','tat gate test','ke ca khi test fail','ke ca khi kiem thu that bai','bo qua verify','bo qua xac minh','khong can chay test'
  ],
  REVIEW:[
    'skip review','skip the review','skip code review','bypass review','bypass the review','without review','without code review','no review needed','without a second pair of eyes',
    'bo qua review','khong can review','bo qua duyet code','khong can duyet code','merge luon','merge luon vao main','khong can ai review'
  ],
  // "overridden despite its verdict" is one of the three forms the DENY doctrine
  // names, and the first version of this table had only the switched-off and
  // waived forms.
  SECURITY_CONTROL:[
    'disable the compliance gate','disable the security gate','disable the gate','turn off the gate','turn off the compliance gate','override the compliance gate','override the gate','override the verification gate','bypass the security','bypass security','disable the guardrails','turn off the guardrails',
    'tat bao mat','tat gate bao mat','bo qua bao mat','bo qua security','tat gate','tat kiem tra bao mat','tat guardrails','bo qua guardrails'
  ],
  SECRETS:SECRET_VERBS.flatMap(v=>SECRET_OBJECTS.map(o=>`${v} ${o}`))
};
// Normalized once at module load: route() runs on every objective and the
// phrase table never changes between calls. The reported entry keeps the
// readable phrase, not the normalized one.
const DENY_MATCHERS=Object.entries(DENY_PHRASES).flatMap(([category,phrases])=>
  phrases.map(phrase=>({entry:`${category}:${phrase}`,needle:` ${normalize(phrase)} `})));
// A phrase match has no polarity, and two attempts to give it one were
// withdrawn after independent review measured them.
//
// The first suppressed a match when a negation cue led into it. It stopped "fix
// the handler so it does not print the credentials" -- and dropped 16 of 19
// genuine demands, because "there is no time, bypass all approvals" and "nobody
// is around, approve it yourself" put the cue in the justification clause and a
// comma is not a word.
//
// The second required a matched phrase to end its noun phrase, with the
// following word drawn from a set of function words. It stopped "show me the
// password reset flow" -- and dropped 34 of 36, because the tail of an English
// imperative is an open class: the set held "now" and "immediately" but not
// "urgently", "quickly", "entirely" or a comma, and no list of words closes it.
//
// Both failed the same way: they traded a visible false positive for a silent
// false negative. For a field whose whole value is telling a reader that a
// phrase is present, the silent drop is the failure that matters, so the
// matcher does not judge. It reports presence:
//
//   - a defensive or reporting sentence containing the words is reported --
//     "fix the handler so it does not print the credentials" reports
//     SECRETS:print the credentials, and that is correct for this field;
//   - so is a phrase sitting inside a longer noun -- "show me the password
//     reset flow" reports SECRETS:show me the password.
//
// Both are noise a reader resolves in one glance at the sentence the entry
// quotes back, and neither can hide a demand. The one judgement the matcher
// does make is that a phrase lies within a single sentence; that boundary, and
// the quarantine of quoted text, are the only ways a verbatim phrase goes
// unreported.
function denyLanguageOf(objective){
  // Quoted and fenced content goes first, on the whole text, so that splitting
  // into sentences cannot cut a quotation in half and leave its contents looking
  // like the operator's own words.
  //
  // Sentences are separated because a phrase must be one, not two halves either
  // side of a full stop: "I will not skip. Review it later." contains no demand
  // to skip review. The split is on sentence punctuation ONLY. A line break is
  // not a sentence end -- objectives arrive wrapped, bulleted and pasted, and
  // splitting on newlines meant "bypass all\napprovals" reported nothing, which
  // review measured as hiding all 170 phrases at one wrap position or another.
  // normalize() folds the newline back into a space, so a wrapped phrase is
  // matched exactly as an unwrapped one.
  const sentences=stripEmbeddedData(objective||'').split(/[.!?;]+/);
  const hits=new Set();
  for(const sentence of sentences){
    const t=` ${normalize(sentence)} `;
    for(const m of DENY_MATCHERS)if(t.includes(m.needle))hits.add(m.entry);
  }
  // Table order, not sentence order, so the same objective always reports the
  // same list in the same sequence.
  return DENY_MATCHERS.filter(m=>hits.has(m.entry)).map(m=>m.entry);
}

// STRICT rules outrank everything else on a tie, since misreading a
// security/incident/db-migration objective as something lower-scrutiny is the
// worse mistake. Below that, "investigate" intent outranks a same-weight
// "change" hit, because an assessment verb usually governs the whole request
// ("investigate optimization opportunities" is a spike about optimization, not
// an optimization change) -- this is what let first-match-wins pick whichever
// rule happened to sit earlier in config/router-rules.json.
const rulePriority=(r,profile)=>profile==='STRICT'?2:(r.intent==='investigate'?1.5:1);
const intentOf=r=>r.intent||'change';

// The profile and the mandatory overlays belong to the workflow, not to the
// keyword rule that happened to select it. config/router-rules.json used to
// carry its own copy of both and had drifted from config/workflows.json for
// modernization, maintenance and incident-response, so the same workflow came
// back STRICT when a keyword picked it and STANDARD when it was named
// explicitly. Both paths now read one table.
const CONFIG_CACHE=new Map();
const ROUTE_DECISION_CACHE=new Map();

export function clearRouterCache(){
  CONFIG_CACHE.clear();
  ROUTE_DECISION_CACHE.clear();
}

export function route(root,objective,explicitWorkflow=null,explicitProfile=null){
  const cacheKey=(!explicitWorkflow&&!explicitProfile)?`${root}:${String(objective||'').trim()}`:null;
  if(cacheKey&&ROUTE_DECISION_CACHE.has(cacheKey)){
    const c=ROUTE_DECISION_CACHE.get(cacheKey);
    return {
      workflow:c.workflow,
      profile:c.profile,
      overlays:[...c.overlays],
      reason_codes:[...c.reason_codes],
      route_flags:[...c.route_flags],
      agent_discretion:c.agent_discretion,
      deny_language:[...c.deny_language]
    };
  }

  const wfPath=path.join(root,'config','workflows.json');
  if(!CONFIG_CACHE.has(wfPath))CONFIG_CACHE.set(wfPath,readJson(wfPath).workflows);
  const wf=CONFIG_CACHE.get(wfPath);

  const entryOf=w=>{const e=wf[w];if(!e)throw new Error(`unknown workflow: ${w}`);return e;};
  const profileOf=w=>entryOf(w).default_profile;
  const overlaysOf=w=>entryOf(w).required_overlays||[];
  if(explicitWorkflow)return {workflow:explicitWorkflow,profile:explicitProfile||profileOf(explicitWorkflow),overlays:overlaysOf(explicitWorkflow),reason_codes:['EXPLICIT_WORKFLOW'],route_flags:[],agent_discretion:false,deny_language:denyLanguageOf(objective)};

  const rulesPath=path.join(root,'config','router-rules.json');
  if(!CONFIG_CACHE.has(rulesPath))CONFIG_CACHE.set(rulesPath,readJson(rulesPath));
  const rules=CONFIG_CACHE.get(rulesPath);

  const candidates=rules.rules.map((rule,idx)=>{
    const profile=profileOf(rule.workflow);
    const hits=rule.keywords.filter(k=>keywordMatch(objective,k));
    const score=hits.reduce((sum,k)=>sum+keywordWords(k)*rulePriority(rule,profile),0);
    return {rule,idx,hits,score,profile};
  }).filter(c=>c.hits.length>0);
  if(!candidates.length){
    const w=rules.default.workflow;
    const result={workflow:w,profile:explicitProfile||profileOf(w),overlays:overlaysOf(w),reason_codes:['DEFAULT_NEW_FEATURE'],route_flags:[],agent_discretion:false,deny_language:denyLanguageOf(objective)};
    if(cacheKey)ROUTE_DECISION_CACHE.set(cacheKey,result);
    return result;
  }
  // Stable score-desc order; a genuine tie prefers STRICT, then declaration
  // order, so the outcome is deterministic rather than array-position luck.
  candidates.sort((a,b)=>b.score-a.score||(a.profile==='STRICT'?0:1)-(b.profile==='STRICT'?0:1)||a.idx-b.idx);
  const [top,second]=candidates;
  const route_flags=[];
  if(top.profile==='STRICT')route_flags.push('STRICT_WORKFLOW_ROUTE');
  const reason_codes=candidates.flatMap(c=>c.hits.map(h=>`KEYWORD:${h}`));
  if(second&&(second.score===top.score||intentOf(second.rule)!==intentOf(top.rule)||second.score>=top.score*0.5)){
    route_flags.push('AMBIGUOUS_ROUTE');
  }
  const agent_discretion=Boolean(top.rule.agent_discretion);
  const result={workflow:top.rule.workflow,profile:explicitProfile||top.profile,overlays:overlaysOf(top.rule.workflow),reason_codes,route_flags,agent_discretion,deny_language:denyLanguageOf(objective)};
  if(cacheKey)ROUTE_DECISION_CACHE.set(cacheKey,result);
  return result;
}

export async function routeSemantic(root,objective,explicitWorkflow=null,explicitProfile=null,options={}){
  const floor=route(root,objective,explicitWorkflow,explicitProfile);
  if(explicitWorkflow)return floor;

  const forceSemantic=Boolean(options.semantic||options.ai);
  const isAmbiguous=floor.route_flags.includes('AMBIGUOUS_ROUTE');
  const isDefault=floor.reason_codes.includes('DEFAULT_NEW_FEATURE');
  const normalizedObj=normalize(objective);
  const hasNegation=/\b(khong duoc|tuyet doi khong|dung|khong nen|cam|do not|never|dont)\b/.test(normalizedObj);

  if(!forceSemantic&&!isAmbiguous&&!isDefault&&!hasNegation){
    return floor;
  }

  const {classifySemanticIntent}=await import('./semantic-classifier.mjs');
  const modelRes=await classifySemanticIntent(root,objective,options);
  if(modelRes.status!=='PASS'||!modelRes.decision){
    return floor;
  }

  const d=modelRes.decision;
  const wfPath=path.join(root,'config','workflows.json');
  if(!CONFIG_CACHE.has(wfPath))CONFIG_CACHE.set(wfPath,readJson(wfPath).workflows);
  const wfMap=CONFIG_CACHE.get(wfPath);

  const chosenWf=(d.workflow&&wfMap[d.workflow])?d.workflow:floor.workflow;
  const chosenProfileDefault=wfMap[chosenWf]?.default_profile||'STANDARD';
  const chosenOverlays=wfMap[chosenWf]?.required_overlays||[];

  let effectiveProfile=explicitProfile||floor.profile;
  if(floor.profile==='STRICT'){
    effectiveProfile='STRICT';
  }else if(d.profile==='STRICT'){
    effectiveProfile='STRICT';
  }else if(d.profile&&['FAST','STANDARD','STRICT'].includes(d.profile)){
    effectiveProfile=d.profile;
  }else{
    effectiveProfile=chosenProfileDefault;
  }

  const route_flags=[];
  if(effectiveProfile==='STRICT')route_flags.push('STRICT_WORKFLOW_ROUTE');
  route_flags.push('SEMANTIC_MODEL_ASSISTED');

  const reason_codes=[
    `MODEL:${modelRes.provider}`,
    ...(d.reason_codes||[]),
    ...floor.reason_codes
  ];

  return {
    workflow:chosenWf,
    profile:effectiveProfile,
    overlays:chosenOverlays,
    reason_codes,
    route_flags,
    agent_discretion:Boolean(floor.agent_discretion),
    deny_language:floor.deny_language,
    semantic_decision:{
      provider:modelRes.provider,
      trust_action:d.trust_action||'NONE',
      human_stop_required:Boolean(d.human_stop_required),
      wall_ms:modelRes.wall_ms
    }
  };
}

