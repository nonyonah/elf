/** Curated setup recipes. Commands never contain project/model-supplied package names. */
export const componentLibraries = [
 {id:'native',label:'Native HTML elements',description:'Use your own styles, with no additional component dependency.',packages:[],docs:'https://react.dev/reference/react-dom/components',steps:['No component library setup is required. Review semantics and accessibility.']},
 {id:'@mui/material',label:'Material UI',description:'Styled Material Design components and a theme system.',packages:['@mui/material','@emotion/react','@emotion/styled'],docs:'https://mui.com/material-ui/getting-started/installation/',steps:['Review React peer versions in the installation guide. React 18 and earlier require matching react-is overrides.','Review theme/provider and SSR integration for your framework before generating production components.']},
 {id:'@mantine/core',label:'Mantine',description:'Styled components, hooks, and application UI building blocks.',packages:['@mantine/core','@mantine/hooks'],docs:'https://mantine.dev/getting-started/',steps:["Import '@mantine/core/styles.css' in your application entry and wrap the app with MantineProvider.",'Follow the framework guide for PostCSS and SSR setup. Existing application configuration is never overwritten automatically.']},
];
export function componentLibraryChoices(installed:string[]) {
 return [...componentLibraries.map(item=>({...item,installed:item.id==='native'||installed.includes(item.id)})),...installed.filter(id=>!componentLibraries.some(item=>item.id===id)).map(id=>({id,label:id,description:'Already declared in this project. Review its provider and framework setup.',packages:[id],docs:'',steps:['Keep your existing library configuration.'],installed:true}))];
}
