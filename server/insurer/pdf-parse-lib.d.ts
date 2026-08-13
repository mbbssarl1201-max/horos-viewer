// Déclaration pour l'import du module interne de pdf-parse (contournement du
// bloc debug de l'index.js — cf. commentaire dans mailPoller.ts).
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdf from "pdf-parse";
  export default pdf;
}
