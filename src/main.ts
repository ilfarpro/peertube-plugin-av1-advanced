import { PluginSettingsManager, PluginTranscodingManager } from "@peertube/peertube-types"
import { EncoderOptions, EncoderOptionsBuilderParams, RegisterServerOptions, VideoResolution } from "@peertube/peertube-types"
import { Logger } from 'winston'

let logger : Logger
let transcodingManager : PluginTranscodingManager

const DEFAULT_HARDWARE_DECODE : boolean = false
const DEFAULT_QUALITY : number = 5
const DEFAULT_CRF : number = 28
const DEFAULT_GOP : number = 1
const DEFAULT_BITRATES : Map<VideoResolution, number> = new Map([
    [VideoResolution.H_NOVIDEO, 64 * 1000],
    [VideoResolution.H_144P, 1500 * 1000],
    [VideoResolution.H_360P, 2500 * 1000],
    [VideoResolution.H_480P, 3500 * 1000],
    [VideoResolution.H_720P, 6500 * 1000],
    [VideoResolution.H_1080P, 11000 * 1000],
    [VideoResolution.H_1440P, 17_000 * 1000],
    [VideoResolution.H_4K, 33_000 * 1000]
])

interface PluginSettings {
    hardwareDecode : boolean
    quality: number
    crf: number
    gop: number
    baseBitrate: Map<VideoResolution, number>
}
let pluginSettings : PluginSettings = {
    hardwareDecode: DEFAULT_HARDWARE_DECODE,
    quality: DEFAULT_QUALITY,
    crf: DEFAULT_CRF,
    gop: DEFAULT_GOP,
    baseBitrate: new Map(DEFAULT_BITRATES)
}

let latestStreamNum = 9999

export async function register({settingsManager, peertubeHelpers, transcodingManager: transcode, registerSetting} :RegisterServerOptions) {
    logger = peertubeHelpers.logger
    transcodingManager = transcode

    logger.info("Registering peertube-plugin-av1-advanced");

    const encoder = 'libsvtav1'
    const audio_encoder = 'libopus'
    const profileName = 'SVT-AV1'

    // Add trasncoding profiles
    transcodingManager.addVODProfile(encoder, profileName, vodBuilder)
    transcodingManager.addVODProfile(audio_encoder, profileName, vodAudioBuilder)

    transcodingManager.addVODEncoderPriority('video', encoder, 1000)
    transcodingManager.addVODEncoderPriority('audio', audio_encoder, 1000)

    transcodingManager.addLiveProfile(encoder, profileName, liveBuilder)
    transcodingManager.addLiveEncoderPriority('video', encoder, 1000)
    transcodingManager.addLiveEncoderPriority('audio', audio_encoder, 1000)

    // Load existing settings and default to constants if not present
    await loadSettings(settingsManager)

    registerSetting({
        name: 'hardware-decode',
        label: 'Hardware decode [BROKEN, DO NOT ENABLE]',

        type: 'input-checkbox',

        descriptionHTML: 'Currently broken. Setting enables hardware encoder instead of software one. This highly improves encoding speed but end result will be looking slightly worse compared to softrware encoded video.',

        default: DEFAULT_HARDWARE_DECODE,
        private: false
    })
    registerSetting({
        name: 'quality',
        label: 'SVT-AV1 preset',

        type: 'select',
        options: [
            { label: 'Recommended HQ (5)', value: '5' },
            { label: '10', value: '10' },
            { label: '9', value: '9' },
            { label: '8', value: '8' },
            { label: '7', value: '7' },
            { label: '6', value: '6' },
            { label: '5', value: '5' },
        ],

        descriptionHTML: 'This parameter controls the speed / quality tradeoff. Lower values mean better quality but way more slower encoding. Higher values mean faster encoding but lower quality. This setting is hardware dependent, you may need to experiment to find the best value for your hardware.',

        default: DEFAULT_QUALITY.toString(),
        private: false
    })

    registerSetting({
        name: 'crf',
        label: 'CRF',

        type: 'select',
        options: [
            { label: 'Recommended (28)', value: '28' },
            { label: '38', value: '38' },
            { label: '37', value: '37' },
            { label: '36', value: '36' },
            { label: '35', value: '35' },
            { label: '34', value: '34' },
            { label: '33', value: '33' },
            { label: '32', value: '32' },
            { label: '31', value: '31' },
            { label: '30', value: '30' },
            { label: '29', value: '29' },
            { label: '28', value: '28' },
            { label: '27', value: '27' },
            { label: '26', value: '26' },
            { label: '25', value: '25' },
            { label: '24', value: '24' },
            { label: '23', value: '23' },
            { label: '22', value: '22' },
            { label: '21', value: '21' },
            { label: '20', value: '20' },
            { label: '19', value: '19' },
            { label: '18', value: '18' },
            { label: '17', value: '17' },
            { label: '16', value: '16' },
            { label: '15', value: '15' },
            { label: '14', value: '14' },
        ],

        descriptionHTML: 'This parameter controls the compression / quality tradeoff. Lower values mean better quality but higher filesize and higher bandwidth consumption. You may need to experiment to find the best value for you.',

        default: DEFAULT_CRF.toString(),
        private: false
    })

    registerSetting({
        name: 'gop',
        label: 'GoP size (seconds)',

        type: 'select',
        options: [
            { label: 'Recommended (1)', value: '1' },
            { label: '1', value: '1' },
            { label: '2', value: '2' },
            { label: '3', value: '3' },
            { label: '4', value: '4' },
        ],

        descriptionHTML: 'This parameter controls GoP (Group of Picture) size. Lower values mean better quality and less playback seeking latency but higher filesize and bandwidth consumption. Higher values will bring blocky artifact. You may need to experiment to find the best value for you.',

        default: DEFAULT_GOP.toString(),
        private: false
    })

    registerSetting({
        name: 'base-bitrate-description',
        label: 'Max bitrate',

        type: 'html',
        html: '',
        descriptionHTML: `The base bitrate for video in bits. Plugin prefers minimum bitrate between the bitrate setting and video bitrate.<br/>This bitrate used when the video is transcoded at 30 FPS. The bitrate will be scaled linearly between this value and the maximum bitrate when the video is transcoded at 60 FPS. Wrong values are replaced by default values.`,
           
        private: true,
    })
    for (const [resolution, bitrate] of pluginSettings.baseBitrate) {
        logger.info("registering bitrate setting: "+ bitrate.toString())
        registerSetting({
            name: `base-bitrate-${resolution}`,
            label: `Max bitrate for ${printResolution(resolution)}`,

            type: 'input',

            default: DEFAULT_BITRATES.get(resolution)?.toString(),
            descriptionHTML: `Default value: ${DEFAULT_BITRATES.get(resolution)}`,

            private: false
        })
    }

    settingsManager.onSettingsChange(async (settings) => {
        loadSettings(settingsManager)
    })
}

export async function unregister() {
    logger.info("Unregistering peertube-plugin-av1-advanced")
    transcodingManager.removeAllProfilesAndEncoderPriorities()
    return true
}

async function loadSettings(settingsManager: PluginSettingsManager) {
    pluginSettings.hardwareDecode = await settingsManager.getSetting('hardware-decode') == "true"
    pluginSettings.quality = parseInt(await settingsManager.getSetting('quality') as string) || DEFAULT_QUALITY
    pluginSettings.crf = parseInt(await settingsManager.getSetting('crf') as string) || DEFAULT_CRF
    pluginSettings.gop = parseInt(await settingsManager.getSetting('gop') as string) || DEFAULT_GOP

    for (const [resolution, bitrate] of DEFAULT_BITRATES) {
        const key = `base-bitrate-${resolution}`
        const storedValue = await settingsManager.getSetting(key) as string
        pluginSettings.baseBitrate.set(resolution, parseInt(storedValue) || bitrate)
        logger.info(`Bitrate ${printResolution(resolution)}: ${pluginSettings.baseBitrate.get(resolution)}`)
    }

    logger.info(`Hardware decode: ${pluginSettings.hardwareDecode}`)
    logger.info(`SVT-AV1 preset: ${pluginSettings.quality}`)
    logger.info(`CRF: ${pluginSettings.crf}`)
    logger.info(`GOP: ${pluginSettings.gop}`)
}

function printResolution(resolution : VideoResolution) : string {
    switch (resolution) {
        case VideoResolution.H_NOVIDEO: return 'audio only'
        case VideoResolution.H_144P:
        case VideoResolution.H_360P:
        case VideoResolution.H_480P:
        case VideoResolution.H_720P:
        case VideoResolution.H_1080P:
        case VideoResolution.H_1440P:
            return `${resolution}p`
        case VideoResolution.H_4K: return '4K'

        default: return 'Unknown'
    }
}

function buildInitOptions() {
    if (pluginSettings.hardwareDecode) {
        return [
            '-hwaccel vaapi',
            '-vaapi_device /dev/dri/renderD128',
            '-hwaccel_output_format vaapi',
        ]
    } else {
        return [
            '-hide_banner'
        ]
    }
}

async function vodBuilder(params: EncoderOptionsBuilderParams) : Promise<EncoderOptions> {
    const { resolution, fps, streamNum, inputBitrate } = params
    //const streamSuffix = streamNum == undefined ? '' : `:${streamNum}`
    let targetBitrate = getTargetBitrate(resolution, fps)
    let shouldInitVaapi = (streamNum == undefined || streamNum <= latestStreamNum)

    if (targetBitrate > inputBitrate) {
        targetBitrate = inputBitrate
    }

    logger.info(`Building encoder options, received ${JSON.stringify(params)}`)
    
    if (shouldInitVaapi && streamNum != undefined) {
        latestStreamNum = streamNum
    }
    // SOFTWARE ENCODING SETTINGS
    let options : EncoderOptions = {
        scaleFilter: {
            // software decode requires specifying pixel format for hardware filter and upload it to GPU
            name: pluginSettings.hardwareDecode ? 'scale' : 'scale'
        },
        inputOptions: shouldInitVaapi ? buildInitOptions() : [],
        outputOptions: [
            `-preset ${pluginSettings.quality}`,
            `-pix_fmt yuv420p`,
            `-crf ${pluginSettings.crf}`,
            `-maxrate ${targetBitrate}`,
            `-bufsize ${targetBitrate * 2}`,
            `-g ${fps}*${pluginSettings.gop}`,
            `-svtav1-params tune=0:fast-decode=1:tile-rows=3:tile-columns=4:variance-boost-strength=2`
        ]
    }
    logger.info(`EncoderOptions: ${JSON.stringify(options)}`)
    return options 
}

async function vodAudioBuilder(params: EncoderOptionsBuilderParams) : Promise<EncoderOptions> {
    // AUDIO ENCODING SETTINGS
    let options : EncoderOptions = {
        scaleFilter: {
            // software decode requires specifying pixel format for hardware filter and upload it to GPU
            name: pluginSettings.hardwareDecode ? 'scale' : 'scale'
        },
        inputOptions: [],
        outputOptions: [
            `-b:a 320k`,
            `-af loudnorm=I=-14:LRA=11:TP=-1`
        ]
    }
    logger.info(`EncoderOptions: ${JSON.stringify(options)}`)
    return options 
}

async function liveBuilder(params: EncoderOptionsBuilderParams) : Promise<EncoderOptions> {
    const { resolution, fps, streamNum, inputBitrate } = params
    const streamSuffix = streamNum == undefined ? '' : `:${streamNum}`
    let targetBitrate = getTargetBitrate(resolution, fps)
    let shouldInitVaapi = (streamNum == undefined || streamNum <= latestStreamNum)

    if (targetBitrate > inputBitrate) {
        targetBitrate = inputBitrate
    }

    logger.info(`Building encoder options, received ${JSON.stringify(params)}`)

    if (shouldInitVaapi && streamNum != undefined) {
      latestStreamNum = streamNum
    }

    // You can also return a promise
    const options = {
      scaleFilter: {
        name: pluginSettings.hardwareDecode ? 'scale' : 'scale'
      },
      inputOptions: shouldInitVaapi ? buildInitOptions() : [],
      outputOptions: [
        `-preset ${pluginSettings.quality}`,
        `-r:v${streamSuffix} ${fps}`,
        `-profile:v${streamSuffix} high`,
        `-level:v${streamSuffix} 3.1`,
        `-g:v${streamSuffix} ${fps*1}`,
        `-b:v${streamSuffix} ${targetBitrate}`,
        `-bufsize ${targetBitrate * 2}`,
        `-map_metadata -1`,
      ]
    }
    logger.info(`EncoderOptions: ${JSON.stringify(options)}`)
    return options
}

/**
 * Calculate the target bitrate based on video resolution and FPS.
 *
 * The calculation is based on two values:
 * Bitrate at VideoTranscodingFPS.AVERAGE is always the same as
 * getBaseBitrate(). Bitrate at VideoTranscodingFPS.MAX is always
 * getBaseBitrate() * 1.6. All other values are calculated linearly
 * between these two points.
 */
function getTargetBitrate (resolution : VideoResolution, fps : number) : number {
    const baseBitrate = pluginSettings.baseBitrate.get(resolution) || 0
    const maxBitrate = baseBitrate * 1.6
    const maxBitrateDifference = maxBitrate - baseBitrate
    const maxFpsDifference = 60 - 30
    return Math.floor(baseBitrate + (fps - 30) * (maxBitrateDifference / maxFpsDifference))
}
