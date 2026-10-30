/** Bounded heuristics produce review questions, never automatic Figma variants. */
export interface StateReviewComponent {
  name:string; documentation:string; sourceLine:number; specification:Record<string,unknown>;
  stateReview?:{decision:'include'|'skip'};
}
const interactionStates=/\b(default|hover|focus(?:ed|visible)?|pressed|disabled|checked|unchecked|indeterminate|selected|unselected|expanded|collapsed|open|closed|loading|error|invalid|active|inactive)\b/gi;
function statesIn(text:string){return new Set((text.match(interactionStates)??[]).map(s=>s.toLowerCase().replace(/^focused$|^focusvisible$/,'focus')));}
function sourceSection(markdown:string,line:number){
  const lines=markdown.split(/\r?\n/),start=Math.max(0,line-1);
  const heading=/^\s{0,3}(#{1,6})\s/.exec(lines[start]??'');
  let end=Math.min(lines.length,start+100);
  for(let i=start+1;i<end;i++){
    const next=/^\s{0,3}(#{1,6})\s/.exec(lines[i]);
    if(next&&(!heading||next[1].length<=heading[1].length)){end=i;break;}
    // A non-heading component entry must not borrow another component's states.
    if(!heading&&i>start&&/^\s*(?:[-*]\s+)?[A-Z][^:]{0,100}:/.test(lines[i])){end=i;break;}
  }
  return lines.slice(start,end).join('\n');
}
function variantStates(spec:Record<string,unknown>):Set<string>{
  const variants=spec.variants;
  if(Array.isArray(variants))return statesIn(variants.map(v=>JSON.stringify((v as {props?:unknown})?.props??{})).join(' '));
  if(variants&&typeof variants==='object')return statesIn(Object.keys(variants).join(' '));
  return new Set();
}
export function componentStateSuggestions(markdown:string,components:StateReviewComponent[]){
  return components.flatMap(component=>{
    const n=component.name.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase();
    const context=sourceSection(markdown,component.sourceLine);
    const behavior=`${component.documentation}\n${context}`.toLowerCase();
    let recommendedStates:string[]|undefined,reason='';
    if(/\b(switch|toggle|checkbox|check box|radio)\b/.test(n)){recommendedStates=['Unchecked','Checked','Focus','Disabled'];reason='A selection control has on/off or selected/unselected behavior.';}
    else if(/\b(input|text field|textfield|text area|textarea|combobox|combo box|select)\b/.test(n)){recommendedStates=['Default','Focus','Error','Disabled'];reason='An input control needs interaction and validation states.';}
    else if(/\b(dropdown|drop down|accordion|disclosure|popover|dialog|modal)\b/.test(n)){recommendedStates=['Closed','Open','Focus'];reason='This component opens, closes or expands.';}
    else if(/\b(button|link|tab|tabs|pagination|slider|menu item|nav item)\b/.test(n)){recommendedStates=['Default','Hover','Focus','Pressed','Disabled'];reason='This component is an interactive control.';}
    else if(/\b(clickable|interactive|selectable|dismissible|editable|draggable)\b/.test(behavior)&&!/\b(?:not|non)[ -]?(?:clickable|interactive|selectable|dismissible|editable|draggable)\b/.test(behavior)){recommendedStates=['Default','Hover','Focus','Disabled'];reason='Its documented behavior indicates user interaction.';}
    if(!recommendedStates)return [];
    const documented=statesIn(context),implemented=variantStates(component.specification);
    // Existing documented state specifications need no new opt-in prompt.
    if(documented.size>=2&&implemented.size>=2&&!component.stateReview)return [];
    const decision=component.stateReview?.decision;
    return [{component:component.name,sourceLine:component.sourceLine,reason,recommendedStates,
      decision:decision??'pending',resolved:decision==='skip'&&(implemented.size<2||documented.size>=2)||decision==='include'&&implemented.size>=2,
      question:`${component.name} appears interactive. Would you like state variants (${recommendedStates.join(', ')}), or should it remain as documented?`,
      next:decision==='skip'&&implemented.size>=2&&documented.size<2?'Remove unapproved state variants to keep the component as documented.':decision==='include'&&implemented.size<2?'Review explicit state visuals and add state variants before continuing.':decision==='skip'?'Keep the component as documented; no state variants are added.':'Ask the user before adding states; review state visuals separately.'}];
  });
}
