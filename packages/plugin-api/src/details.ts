/** Conditional-visibility comparison operators supported by plugin input UIs. */
export type InputCondition = '===' | '!==' | '>' | '>=' | '<' | '<=' | 'includes' | 'notIncludes';

export interface InputDisplayCondition {
  name: string;
  value: string;
  condition: InputCondition;
}

export interface InputDisplayConditionSet {
  logic: 'AND' | 'OR';
  inputs: InputDisplayCondition[];
}

export interface PluginInputUi {
  type: 'dropdown' | 'text' | 'textarea' | 'directory' | 'slider' | 'switch' | 'codeEditor';
  options?: string[];
  sliderOptions?: { min: number; max: number };
  style?: Record<string, unknown>;
  /** Choosing a value may rewrite sibling input values: value -> { inputName: newValue }. */
  onSelect?: Record<string, Record<string, string>>;
  displayConditions?: { logic: 'AND' | 'OR'; sets: InputDisplayConditionSet[] };
}

export interface PluginInput {
  label: string;
  name: string;
  type: 'string' | 'boolean' | 'number';
  defaultValue: string;
  tooltip: string;
  inputUI: PluginInputUi;
}

export interface PluginOutputDescriptor {
  number: number;
  tooltip: string;
  /**
   * What this output MEANS, as the node's own author declares it —
   * machine-readable, unlike `tooltip`.
   *
   * `'failure'` says "reaching this output means this node did not do what
   * it was asked to do" (ffmpeg exited non-zero, verification rejected the
   * output, a replacement was refused). It is NOT "the other branch of a
   * question": a filter node answering "this file is not hevc" is reporting
   * a fact, not a failure, and must leave this undefined.
   *
   * The host reads it to answer a question no plugin id list can answer
   * generally: a flow that ENDS on a `'failure'` output the flow author
   * routed nowhere has not converged on anything, and must never be
   * recorded as a success (see `runJob`). Absent (the Tdarr-compatible
   * shape every community plugin already ships) means "unspecified", which
   * is treated as neutral — a plugin that wants its failure branch to
   * participate declares it.
   */
  outcome?: 'success' | 'failure';
}

export interface PluginDetails {
  name: string;
  nameUI?: { type: 'text' | 'textarea'; style?: Record<string, unknown> };
  description: string;
  style: {
    borderColor: string;
    opacity?: number;
    borderRadius?: number | string;
    width?: number | string;
    height?: number | string;
    backgroundColor?: string;
  };
  tags: string;
  isStartPlugin: boolean;
  pType: 'start' | 'onFlowError' | '';
  sidebarPosition: number;
  icon: string;
  inputs: PluginInput[];
  outputs: PluginOutputDescriptor[];
  requiresVersion: string;
}
