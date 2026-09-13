import {
  assertCommandInitialised,
  describeCommandChanges,
  mappableStreams,
  shouldCopyStream,
} from '@trawlarr/core';
import type {
  FfmpegCommandStream,
  PluginDetails,
  PluginInputArgs,
  PluginOutputArgs,
} from '@trawlarr/plugin-api';
import {
  configuredCodec,
  dispositionFlag,
  passThrough,
  textInput,
} from '../media-track-options.js';

export const details = (): PluginDetails => ({
  name: 'Set Container',
  description:
    'Remux to a container without encoding untouched streams; reject incompatible retained codecs.',
  style: { borderColor: '#cc9933' },
  tags: 'ffmpeg,container,remux',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 4,
  icon: 'faFileVideo',
  inputs: [
    {
      name: 'container',
      label: 'Container',
      type: 'string',
      defaultValue: '',
      tooltip:
        'Empty preserves the current container. Choose mkv, mp4, mov, or webm. Place this node AFTER ' +
        'track selection and encoder nodes, immediately before Execute, so compatibility checks see ' +
        'the final streams. Unsupported retained codecs fail with guidance unless Drop unsupported ' +
        'streams is on; nothing is transcoded. Attached pictures can only be remuxed safely to mp4. ' +
        'An already matching container is not rewritten.',
      inputUI: { type: 'dropdown', options: ['', 'mkv', 'mp4', 'mov', 'webm'] },
    },
    {
      name: 'dropUnsupported',
      label: 'Drop unsupported streams',
      type: 'boolean',
      defaultValue: 'false',
      tooltip:
        'Remove cover art, subtitles, attachments and data the container cannot hold, instead of ' +
        'failing the file. Video and audio are never dropped.',
      inputUI: { type: 'switch' },
    },
  ],
  outputs: [{ number: 1, tooltip: 'Container selected and retained codecs checked' }],
  requiresVersion: '1.0.0',
});

const codecs = (list: string): ReadonlySet<string> => new Set(list.split(' '));
const MATROSKA = {
  video: codecs(
    'h264 hevc av1 vp8 vp9 mpeg1video mpeg2video mpeg4 msmpeg4v3 vc1 wmv3 theora ffv1 huffyuv mjpeg png prores dirac',
  ),
  audio: codecs(
    'aac ac3 eac3 dts truehd mp2 mp3 flac alac opus vorbis wavpack tta mlp pcm_s16le pcm_s24le pcm_s32le pcm_f32le pcm_f64le pcm_s16be pcm_s24be pcm_s32be',
  ),
  subtitle: codecs('subrip srt ass ssa webvtt dvd_subtitle dvb_subtitle hdmv_pgs_subtitle'),
};
const MP4 = {
  video: codecs('h264 hevc av1 vp9 mpeg4 mpeg2video mjpeg png'),
  audio: codecs('aac ac3 eac3 mp3 alac opus flac'),
  subtitle: codecs('mov_text'),
};
const MOV = {
  video: codecs('h264 hevc mpeg4 mpeg2video mjpeg png prores qtrle dvvideo'),
  audio: codecs(
    'aac ac3 eac3 mp3 alac pcm_s16le pcm_s24le pcm_s32le pcm_s16be pcm_s24be pcm_s32be pcm_f32le pcm_f64le',
  ),
  subtitle: codecs('mov_text'),
};
const WEBM = {
  video: codecs('vp8 vp9 av1'),
  audio: codecs('vorbis opus'),
  subtitle: codecs('webvtt'),
};
const CONTAINERS = { mkv: MATROSKA, mp4: MP4, mov: MOV, webm: WEBM };
const ENCODER_CODECS: Record<string, string> = {
  libx264: 'h264',
  libx265: 'hevc',
  libsvtav1: 'av1',
  libaom_av1: 'av1',
  'libaom-av1': 'av1',
  libvpx: 'vp8',
  'libvpx-vp9': 'vp9',
  libopus: 'opus',
  libvorbis: 'vorbis',
  libmp3lame: 'mp3',
  libfdk_aac: 'aac',
};

const normaliseContainer = (container: string): string =>
  container.trim().replace(/^\.+/, '').toLowerCase();

const outputCodec = (stream: FfmpegCommandStream): string => {
  const configured = configuredCodec(stream);
  if (configured === undefined && (stream.forceEncoding || !shouldCopyStream(stream.outputArgs))) {
    throw new Error(
      'Set Container cannot validate an encode without an explicit codec. ' +
        'Configure a per-stream encoder before Set Container.',
    );
  }
  const encoder = configured ?? 'copy';
  if (encoder === 'copy') return stream.codec_name;
  return ENCODER_CODECS[encoder] ?? encoder.replace(/_(?:nvenc|qsv|vaapi|videotoolbox|amf)$/, '');
};

export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  const command = args.variables.ffmpegCommand;
  assertCommandInitialised(command);
  const container = normaliseContainer(textInput(args.inputs.container, 'Container'));
  if (container === '') return passThrough(args);
  if (!Object.hasOwn(CONTAINERS, container)) {
    throw new Error(
      'Set Container supports mkv, mp4, mov, or webm; leave it empty to preserve the container.',
    );
  }
  if (
    normaliseContainer(command.container) === container &&
    describeCommandChanges({
      command,
      source: {
        path: args.inputFileObj._id,
        container: args.inputFileObj.container,
        streams: args.inputFileObj.ffProbeData.streams,
      },
    }).length === 0
  ) {
    return passThrough(args);
  }
  if (
    command.overallOuputArguments.some((arg) =>
      /^-(?:c|codec|vcodec|acodec|scodec)(?::|$)/.test(arg),
    )
  ) {
    throw new Error(
      'Set Container cannot validate global codec overrides. Configure per-stream encoders ' +
        'before Set Container instead of overall output codec arguments.',
    );
  }
  const supported = CONTAINERS[container as keyof typeof CONTAINERS];
  // A stored flow hands a switch over as the STRING 'false'; a test hands it
  // the boolean. Truthy-checking the string would switch dropping ON for
  // every flow that ever saved this node off, so only an explicit true counts.
  const dropUnsupported = String(args.inputs.dropUnsupported ?? 'false') === 'true';
  const drop = (stream: FfmpegCommandStream, what: string): void => {
    stream.removed = true;
    args.jobLog(
      `Set Container dropped ${what} (stream ${String(stream.index ?? '?')}, ` +
        `${stream.codec_name}), which ${container} cannot hold.`,
    );
  };
  let dropped = false;
  for (const stream of mappableStreams(command.streams)) {
    const codec = outputCodec(stream);
    const attachedPicture = dispositionFlag(stream, 'attached_pic');
    // ffmpeg silently drops mapped pictures in MOV and writes them as ordinary
    // video in Matroska. A successful mux is not proof the artwork survived.
    if (attachedPicture && (container !== 'mp4' || !['mjpeg', 'png'].includes(codec))) {
      if (dropUnsupported) {
        drop(stream, 'cover art');
        dropped = true;
        continue;
      }
      // Says what would actually happen, and names the switch that fixes it.
      // The old wording ("when remuxing to mkv") read as a CONTAINER change,
      // which baffled an operator whose file was already mkv: the rewrite
      // comes from the flow's other changes, not from Set Container.
      const consequence =
        container === 'mkv'
          ? 'would turn the artwork into an ordinary video track'
          : container === 'mov'
            ? 'would silently drop the artwork'
            : `cannot hold ${codec} artwork`;
      const subject =
        normaliseContainer(args.inputFileObj.container ?? '') === container
          ? `This file is already ${container}, but this flow rewrites it, and ${container}`
          : `Writing ${container}`;
      throw new Error(
        `Set Container cannot preserve attached cover art (${codec}) in ${container}. ` +
          `${subject} ${consequence}. Turn on Drop unsupported streams to remove it, or use ` +
          'mp4, which keeps JPEG/PNG artwork. Nothing was changed.',
      );
    }
    const type = attachedPicture ? 'video' : stream.codec_type;
    // Matroska has native attachments (fonts, artwork); the other muxers do not.
    if (type === 'attachment' && container === 'mkv') continue;
    const allowed = supported[type as keyof typeof supported];
    if (allowed?.has(codec)) continue;
    // Never video or audio, whatever the switch says. Those ARE the
    // programme: mkv to webm with an h264 picture would "succeed" with no
    // picture at all, and the Replace step would install it. What a remux
    // can shed without losing what the file is for is everything else.
    if (dropUnsupported && type !== 'video' && type !== 'audio') {
      drop(stream, `a ${type} stream`);
      dropped = true;
      continue;
    }
    throw new Error(
      `Set Container cannot safely copy ${type} stream ${String(stream.index ?? '?')} ` +
        `(${codec}) into ${container}. Choose a compatible container (often mkv), explicitly remove ` +
        'this track with a preceding track-selection node, or configure a compatible encoder before ' +
        'Set Container. No streams were dropped or automatically transcoded.',
    );
  }
  if (normaliseContainer(command.container) !== container) {
    command.container = container;
    command.shouldProcess = true;
  }
  // A removal is a change to write even into a container the file already
  // has; without this, a same-container file whose only fix was a drop would
  // be skipped and fail the same way on its next pass.
  if (dropped) command.shouldProcess = true;
  return passThrough(args);
};
