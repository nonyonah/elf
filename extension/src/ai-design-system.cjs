function parseDesignSystemDraft(text) {
  if(Buffer.byteLength(text)>128000)throw new Error('Design-system draft exceeds 128 KB.');
  const raw=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let draft;try{draft=JSON.parse(raw);}catch{throw new Error('The model returned invalid JSON. No design-system resources were changed.');}
  if(!draft||typeof draft!=='object'||Array.isArray(draft))throw new Error('Expected a design-system draft object.');
  return draft;
}
async function generateDesignSystem(vscode,prepared) {
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before generating a design-system draft.');
  if(!vscode.lm?.selectChatModels)throw new Error('Use manual extraction or MCP; this editor does not expose language models.');
  const models=await vscode.lm.selectChatModels({});
  if(!models.length)throw new Error('No editor models available. Configure a provider or use manual extraction.');
  const selected=await vscode.window.showQuickPick(models.map(model=>({label:model.name,description:model.vendor,model})),{title:'Choose a model for Markdown extraction'});
  if(!selected)return null;
  const consent=await vscode.window.showWarningMessage(`Send the full contents of ${prepared.source.path} to ${selected.model.vendor} / ${selected.model.name}? Review the source tab first. Provider data policies and usage charges may apply. Generation prepares a draft only.`,{modal:true},'Send Markdown and extract');
  if(consent!=='Send Markdown and extract')return null;
  return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Extracting design-system draft',cancellable:true},async(_progress,token)=>{
    try {
      const message=prepared.instructions+'\n\n'+JSON.stringify({path:prepared.source.path,markdown:prepared.source.markdown});
      const response=await selected.model.sendRequest([vscode.LanguageModelChatMessage.User(message)],{},token);
      let text='';for await(const chunk of response.text){if(token.isCancellationRequested)return null;text+=chunk;if(Buffer.byteLength(text)>128000)throw new Error('Draft exceeds limit.');}
      return token.isCancellationRequested?null:parseDesignSystemDraft(text);
    }catch(error){if(token.isCancellationRequested)return null;throw new Error('Design-system extraction failed or returned an invalid draft. No project or Figma resources were changed.');}
  });
}
module.exports={parseDesignSystemDraft,generateDesignSystem};
