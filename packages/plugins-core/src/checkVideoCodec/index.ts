import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';

export const details = (): PluginDetails => ({
  name: 'Check Video Codec',
  description: 'Branch on whether the video stream already uses a given codec.',
  style: { borderColor: '#3399cc' },
  tags: 'video,filter',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [
    {
      label: 'Codec',
      name: 'codec',
      type: 'string',
      defaultValue: 'hevc',
      tooltip: 'The codec to test for, as ffprobe names it — for example hevc, h264, av1.',
      inputUI: { type: 'dropdown', options: ['hevc', 'h264', 'av1', 'vp9', 'mpeg4'] },
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Video already uses this codec' },
    { number: 2, tooltip: 'Video uses a different codec' },
  ],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  const wanted = String(args.inputs.codec ?? '').toLowerCase();
  const actual = String(args.inputFileObj.video_codec_name ?? '').toLowerCase();
  const matches = wanted !== '' && wanted === actual;

  args.jobLog(`Video codec is "${actual}"; wanted "${wanted}" — ${matches ? 'match' : 'differs'}.`);

  return {
    outputNumber: matches ? 1 : 2,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
