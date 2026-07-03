// @novnc/novnc ne fournit pas de types — déclaration minimale pour l'usage
// view-only de NoVncScreen (constructeur + propriétés d'affichage + events).
declare module "@novnc/novnc" {
  export default class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: Record<string, unknown>
    );
    viewOnly: boolean;
    scaleViewport: boolean;
    background: string;
    disconnect(): void;
    addEventListener(type: string, cb: () => void): void;
    removeEventListener(type: string, cb: () => void): void;
  }
}
