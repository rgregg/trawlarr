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
