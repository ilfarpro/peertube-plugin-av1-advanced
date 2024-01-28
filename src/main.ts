import { PluginSettingsManager, PluginTranscodingManager } from "@peertube/peertube-types"
import { EncoderOptions, EncoderOptionsBuilderParams, RegisterServerOptions, VideoResolution } from "@peertube/peertube-types"
import { Logger } from 'winston'

let logger : Logger
let transcodingManager : PluginTranscodingManager

const DEFAULT_HARDWARE_DECODE : boolean = false
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
const DEFAULT_PRESET : Map<VideoResolution, number> = new Map([
    [VideoResolution.H_NOVIDEO, 12],
    [VideoResolution.H_144P, 4],
    [VideoResolution.H_240P, 4],
    [VideoResolution.H_360P, 4],
    [VideoResolution.H_480P, 4],
    [VideoResolution.H_720P, 5],
    [VideoResolution.H_1080P, 5],
    [VideoResolution.H_1440P, 6],
    [VideoResolution.H_4K, 6]
])
const DEFAULT_PIX_FMT : Map<VideoResolution, string> = new Map([
    [VideoResolution.H_NOVIDEO, 'yuv420p'],
    [VideoResolution.H_144P, 'yuv420p'],
    [VideoResolution.H_240P, 'yuv420p'],
    [VideoResolution.H_360P, 'yuv420p'],
    [VideoResolution.H_480P, 'yuv420p'],
    [VideoResolution.H_720P, 'yuv420p'],
    [VideoResolution.H_1080P, 'yuv420p'],
    [VideoResolution.H_1440P, 'yuv420p'],
    [VideoResolution.H_4K, 'yuv420p10le']
])

interface PluginSettings {
    hardwareDecode : boolean
    gop: number
    crfPerResolution: Map<VideoResolution, number>
    pix_fmtPerResolution: Map<VideoResolution, string>
    preset: Map<VideoResolution, number>
}
let pluginSettings : PluginSettings = {
    hardwareDecode: DEFAULT_HARDWARE_DECODE,
    preset: new Map(DEFAULT_PRESET),
    gop: DEFAULT_GOP,
    crfPerResolution: new Map(DEFAULT_CRF_RES),
    pix_fmtPerResolution: new Map(DEFAULT_PIX_FMT)
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
        descriptionHTML: `Specify CRF for each resolution to get target quality.`,
           
        private: true,
    })
    for (const [resolution, crfPerResolution] of pluginSettings.crfPerResolution) {
        logger.info("registering CRF setting: "+ crfPerResolution.toString())
        registerSetting({
            name: `crf-for-${resolution}`,
            label: `CRF for ${printResolution(resolution)}`,

            type: 'input',

            default: DEFAULT_CRF_RES.get(resolution)?.toString(),
            descriptionHTML: `Default value: ${DEFAULT_CRF_RES.get(resolution)}`,

            private: false
        })
    }

    registerSetting({
        name: 'pix_fmt-res-description',
        label: 'PIX_FMT per Resolution',

        type: 'html',
        html: '',
        descriptionHTML: `Specify PIX_FMT for each resolution to get target quality or filesize at given resolution.`,
           
        private: true,
    })
    for (const [resolution, pix_fmtPerResolution] of pluginSettings.pix_fmtPerResolution) {
        logger.info("registering pix_fmt setting: "+ pix_fmtPerResolution.toString())
        registerSetting({
            name: `pix_fmt-for-${resolution}`,
            label: `PIX_FMT for ${printResolution(resolution)}`,

            type: 'input',

            default: DEFAULT_PIX_FMT.get(resolution)?.toString(),
            descriptionHTML: `Default value: ${DEFAULT_PIX_FMT.get(resolution)}`,

            private: false
        })
    }

    registerSetting({
        name: 'preset-description',
        label: 'SVT-AV1 preset per Resolution',

        type: 'html',
        html: '',
        descriptionHTML: `Specify preset for each resolution to get target quality.`,
           
        private: true,
    })
    for (const [resolution, preset] of pluginSettings.preset) {
        logger.info("registering preset setting: "+ preset.toString())
        registerSetting({
            name: `preset-for-${resolution}`,
            label: `Preset for ${printResolution(resolution)}`,

            type: 'input',

            default: DEFAULT_PRESET.get(resolution)?.toString(),
            descriptionHTML: `Default value: ${DEFAULT_PRESET.get(resolution)}`,

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
    pluginSettings.gop = parseInt(await settingsManager.getSetting('gop') as string) || DEFAULT_GOP

    for (const [resolution, crfPerResolution] of DEFAULT_CRF_RES) {
        const key = `crf-for-${resolution}`
        const storedCRF = await settingsManager.getSetting(key) as string
        pluginSettings.preset.set(resolution, parseInt(storedCRF) || crfPerResolution)
        logger.info(`CRF for ${printResolution(resolution)}: ${pluginSettings.preset.get(resolution)}`)
    }

    for (const [resolution, pix_fmtPerResolution] of DEFAULT_PIX_FMT) {
        const key = `pix_fmt-for-${resolution}`
        const storedValue = await settingsManager.getSetting(key) as string
        pluginSettings.pix_fmtPerResolution.set(resolution, storedValue || pix_fmtPerResolution)
        logger.info(`PIX_FMT for ${printResolution(resolution)}: ${pluginSettings.pix_fmtPerResolution.get(resolution)}`)
    }

    for (const [resolution, preset] of DEFAULT_PRESET) {
        const key = `preset-for-${resolution}`
        const storedValue = await settingsManager.getSetting(key) as string
        pluginSettings.preset.set(resolution, parseInt(storedValue) || preset)
        logger.info(`Preset for ${printResolution(resolution)}: ${pluginSettings.preset.get(resolution)}`)
    }

    logger.info(`Hardware decode: ${pluginSettings.hardwareDecode}`)
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
    let targetPreset = pluginSettings.preset.get(resolution) || 0
    let targetPix_Fmt = pluginSettings.pix_fmtPerResolution.get(resolution)
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
            `-pix_fmt ${targetPix_Fmt}`,
            `-preset ${targetPreset}`,
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
        `-preset ${pluginSettings.preset}`,
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