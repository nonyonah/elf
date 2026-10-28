/** Curated setup recipes. Commands never contain project/model-supplied package names. */
export const componentLibraries = [
 {id:'native',label:'Native HTML elements',description:'Use your own styles, with no additional component dependency.',packages:[],docs:'https://react.dev/reference/react-dom/components',steps:['No component library setup is required. Review semantics and accessibility.']},
 {id:'@mui/material',label:'Material UI',description:'Styled Material Design components and a theme system.',packages:['@mui/material','@emotion/react','@emotion/styled'],docs:'https://mui.com/material-ui/getting-started/installation/',steps:['Review React peer versions in the installation guide. React 18 and earlier require matching react-is overrides.','Review theme/provider and SSR integration for your framework before generating production components.']},
 {id:'@mantine/core',label:'Mantine',description:'Styled components, hooks, and application UI building blocks.',packages:['@mantine/core','@mantine/hooks'],docs:'https://mantine.dev/getting-started/',steps:["Import '@mantine/core/styles.css' in your application entry and wrap the app with MantineProvider.",'Follow the framework guide for PostCSS and SSR setup. Existing application configuration is never overwritten automatically.']},
 {id:'shadcn',label:'shadcn/ui',description:'Local component source you own, styled with your project’s Tailwind theme.',packages:[],docs:'https://ui.shadcn.com/docs/installation',steps:['Run the interactive shadcn init command in the existing project and review changes to components.json, CSS, aliases, and dependencies.','Add the UI components you need with the shadcn CLI, then select those actual local components for reuse. Existing files are never overwritten by Elf.','Generated imports use relative paths to the selected local files, not a shadcn package.']},
 {id:'@heroui/react',label:'HeroUI v3',description:'React 19+ components with Tailwind CSS v4 styles and compound APIs.',packages:['@heroui/react@^3','@heroui/styles@^3'],docs:'https://heroui.com/en/docs/react/getting-started/quick-start',steps:['Requires React and React DOM 19+ and Tailwind CSS v4. Review framework and peer requirements before installing; v2 installations need a reviewed migration.',"Import 'tailwindcss' before '@heroui/styles' in the application CSS entry, and ensure that entry is loaded.",'HeroUI v3 requires no HeroUIProvider. Use v3 compound component APIs; verify the result in the running application.']},
];
export interface LibraryEnvironment {shadcnConfigured?:boolean;versions?:Record<string,string>;}
export function declaredMajor(version:unknown):number|undefined {
 if(typeof version!=='string')return undefined;
 // Conservatively accept a version whose lower bound identifies one major.
 const match=/^[~^]?\s*(\d+)(?:\.|$)/.exec(version.trim());
 return match?Number(match[1]):undefined;
}
export function componentLibraryChoices(installed:string[],environment:LibraryEnvironment={}) {
 return [...componentLibraries.map(item=>({...item,installed:item.id==='native'||(item.id==='shadcn'?environment.shadcnConfigured===true:item.id==='@heroui/react'?declaredMajor(environment.versions?.[item.id])===3&&declaredMajor(environment.versions?.['@heroui/styles'])===3:installed.includes(item.id))})),...installed.filter(id=>!componentLibraries.some(item=>item.id===id)).map(id=>({id,label:id,description:'Already declared in this project. Review its provider and framework setup.',packages:[id],docs:'',steps:['Keep your existing library configuration.'],installed:true}))];
}
