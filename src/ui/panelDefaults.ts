/** Starting state of the control panel's display and run toggles (Spec 07 v1.10, INST-14). */
export interface PanelState {
  follow: boolean;
  autoRepeat: boolean;
  arrows: boolean;
  funnel: boolean;
  tracers: boolean;
  debris: boolean;
  enlargeDebris: boolean;
  damageColors: boolean;
  brightness: number;
  probeHeight: number;
}

export const DEFAULT_PANEL_STATE: Readonly<PanelState> = {
  follow: false,
  autoRepeat: false,
  arrows: false,
  funnel: true,
  tracers: true,
  debris: true,
  enlargeDebris: false,
  damageColors: false,
  brightness: 1,
  probeHeight: 10,
};
