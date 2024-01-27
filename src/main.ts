import { PluginSettingsManager, PluginTranscodingManager } from "@peertube/peertube-types"
import { EncoderOptions, EncoderOptionsBuilderParams, RegisterServerOptions, VideoResolution } from "@peertube/peertube-types"
import { Logger } from 'winston'

let logger : Logger
let transcodingManager : PluginTranscodingManager

const DEFAULT_HARDWARE_DECODE : boolean = false
const DEFAULT_QUALITY : number = 6
const DEFAULT_GOP : number = 2
const DEFAULT_CRF_RES : Map<VideoResolution, number> = new Map([
    [VideoResolution.H_NOVIDEO, 28],
    [VideoResolution.H_144P, 28],
    [VideoResolution.H_240P, 28],
    [VideoResolution.H_360P, 28],
    [VideoResolution.H_480P, 28],
    [VideoResolution.H_720P, 28],
    [VideoResolution.H_1080P, 28],
    [VideoResolution.H_1440P, 28],
    [VideoResolution.H_4K, 28]
])


interface PluginSettings {
    hardwareDecode : boolean
    quality: number
    gop: number
    crfPerResolution: Map<VideoResolution, number>
}
let pluginSettings : PluginSettings = {
    hardwareDecode: DEFAULT_HARDWARE_DECODE,
    quality: DEFAULT_QUALITY,
    gop: DEFAULT_GOP,
    crfPerResolution: new Map(DEFAULT_CRF_RES)
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
            { label: 'Recommended HQ (6)', value: '6' },
            { label: 'Fast 12', value: '12' },
            { label: 'Fast 11', value: '11' },
            { label: 'Fast 10', value: '10' },
            { label: 'Fast 9', value: '9' },
            { label: 'Fast 8', value: '8' },
            { label: 'Fast 7', value: '7' },
            { label: 'Slow 6', value: '6' },
            { label: 'Slow 5', value: '5' },
            { label: 'Slow 4', value: '4' },
        ],

        descriptionHTML: 'This parameter controls the speed / quality tradeoff. Lower values mean better quality but way more slower encoding. Higher values mean faster encoding but lower quality. This setting is hardware dependent, you may need to experiment to find the best value for your hardware.',

        default: DEFAULT_QUALITY.toString(),
        private: false
    })

    registerSetting({
        name: 'gop',
        label: 'GoP size (seconds)',

        type: 'select',
        options: [
            { label: 'Recommended (2)', value: '2' },
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
        name: 'crf-res-description',
        label: 'CRF per Resolution',

        type: 'html',
        html: '',
        descriptionHTML: `Specify CRF for each resolution to get target quality or filesize at given resolution.`,
           
        private: true,
    })
    for (const [resolution, crfPerResolution] of pluginSettings.crfPerResolution) {
        logger.info("registering crf setting: "+ crfPerResolution.toString())
        registerSetting({
            name: `crf-for-${resolution}`,
            label: `CRF for ${printResolution(resolution)}`,

            type: 'input',

            default: DEFAULT_CRF_RES.get(resolution)?.toString(),
            descriptionHTML: `Default value: ${DEFAULT_CRF_RES.get(resolution)}`,

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
    pluginSettings.gop = parseInt(await settingsManager.getSetting('gop') as string) || DEFAULT_GOP

    for (const [resolution, crfPerResolution] of DEFAULT_CRF_RES) {
        const key = `crf-for-${resolution}`
        const storedValue = await settingsManager.getSetting(key) as string
        pluginSettings.crfPerResolution.set(resolution, parseInt(storedValue) || crfPerResolution)
        logger.info(`CRF for ${printResolution(resolution)}: ${pluginSettings.crfPerResolution.get(resolution)}`)
    }

    logger.info(`Hardware decode: ${pluginSettings.hardwareDecode}`)
    logger.info(`SVT-AV1 preset: ${pluginSettings.quality}`)
    logger.info(`GOP: ${pluginSettings.gop}`)
}

function printResolution(resolution : VideoResolution) : string {
    switch (resolution) {
        case VideoResolution.H_NOVIDEO: return 'audio only'
        case VideoResolution.H_144P:
        case VideoResolution.H_240P:
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
    const { resolution, fps, streamNum } = params
    //const streamSuffix = streamNum == undefined ? '' : `:${streamNum}`
    let targetCRF = pluginSettings.crfPerResolution.get(resolution) || 0
    let shouldInitVaapi = (streamNum == undefined || streamNum <= latestStreamNum)

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
            `-sws_flags lanczos+accurate_rnd`,
            `-preset ${pluginSettings.quality}`,
            `-pix_fmt yuv420p`,
            `-crf ${targetCRF}`,
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
    const { fps, streamNum } = params
    const streamSuffix = streamNum == undefined ? '' : `:${streamNum}`
    let shouldInitVaapi = (streamNum == undefined || streamNum <= latestStreamNum)

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
        `-map_metadata -1`,
      ]
    }
    logger.info(`EncoderOptions: ${JSON.stringify(options)}`)
    return options
}