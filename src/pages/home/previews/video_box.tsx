import {
  Flex,
  VStack,
  Image,
  Anchor,
  Tooltip,
  HStack,
  Switch,
  Icon,
  IconButton,
} from "@hope-ui/solid"
import { For, JSXElement, createSignal, createMemo } from "solid-js"
import { useRouter, useLink, useT } from "~/hooks"
import { objStore } from "~/store"
import { ObjType } from "~/types"
import { convertURL, getPlatform } from "~/utils"
import Artplayer from "artplayer"
import { SelectWrapper } from "~/components"
import { BsArrowRight } from "solid-icons/bs"

Artplayer.PLAYBACK_RATE = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

export const players: {
  icon: string
  name: string
  scheme: string
  platforms: string[]
}[] = [
  {
    icon: "iina",
    name: "IINA",
    scheme: "iina://weblink?url=$edurl",
    platforms: ["MacOS"],
  },
  {
    icon: "potplayer",
    name: "PotPlayer",
    scheme: "potplayer://$durl",
    platforms: ["Windows"],
  },
  {
    icon: "vlc",
    name: "VLC",
    scheme: "vlc://$durl",
    platforms: ["Windows", "MacOS", "Linux", "Android", "iOS"],
  },
  {
    icon: "nplayer",
    name: "nPlayer",
    scheme: "nplayer-$durl",
    platforms: ["Android", "iOS"],
  },
  {
    icon: "omniplayer",
    name: "OmniPlayer",
    scheme: "omniplayer://weblink?url=$durl",
    platforms: ["MacOS"],
  },
  {
    icon: "figplayer",
    name: "Fig Player",
    scheme: "figplayer://weblink?url=$durl",
    platforms: ["MacOS"],
  },
  {
    icon: "infuse",
    name: "Infuse",
    scheme: "infuse://x-callback-url/play?url=$durl",
    platforms: ["MacOS", "iOS"],
  },
  {
    icon: "fileball",
    name: "Fileball",
    scheme: "filebox://play?url=$durl",
    platforms: ["MacOS", "iOS"],
  },
  {
    icon: "mxplayer",
    name: "MX Player",
    scheme:
      "intent:$durl#Intent;package=com.mxtech.videoplayer.ad;S.title=$name;end",
    platforms: ["Android"],
  },
  {
    icon: "mxplayer-pro",
    name: "MX Player Pro",
    scheme:
      "intent:$durl#Intent;package=com.mxtech.videoplayer.pro;S.title=$name;end",
    platforms: ["Android"],
  },
  {
    icon: "iPlay",
    name: "iPlay",
    scheme: "iplay://play/any?type=url&url=$bdurl",
    platforms: ["iOS"],
  },
  {
    icon: "mpv",
    name: "mpv",
    scheme: "mpv://$edurl",
    platforms: ["Windows", "MacOS", "Linux", "Android"],
  },
]

export const AutoHeightPlugin = (player: Artplayer) => {
  const { $container, $video } = player.template
  const $videoBox = $container.parentElement!

  player.on("ready", () => {
    const offsetBottom = "1.75rem" // position bottom of "More" button + padding
    $videoBox.style.maxHeight = `calc(100vh - ${$videoBox.offsetTop}px - ${offsetBottom})`
    $videoBox.style.minHeight = "320px" // min width of mobie phone
    player.autoHeight()
  })
  player.on("resize", () => {
    player.autoHeight()
  })
  player.on("error", () => {
    if ($video.style.height) return
    $container.style.height = "60vh"
    $video.style.height = "100%"
  })
}

export const VideoBox = (props: {
  children: JSXElement
  onAutoNextChange: (v: boolean) => void
}) => {
  const { replace } = useRouter()
  const { currentObjLink } = useLink()
  let videos = objStore.objs.filter((obj) => obj.type === ObjType.VIDEO)
  if (videos.length === 0) {
    videos = [objStore.obj]
  }
  const t = useT()
  let autoNext = localStorage.getItem("video_auto_next")
  if (!autoNext) {
    autoNext = "true"
  }
  props.onAutoNextChange(autoNext === "true")

  const [showAll, setShowAll] = createSignal(
    localStorage.getItem("video_show_all_players") === "true",
  )
  const platform = getPlatform()
  const platformPlayers = createMemo(() => {
    if (showAll() || platform === "Unknown") {
      return players
    }
    return players.filter((p) => p.platforms.includes(platform))
  })

  return (
    <VStack w="$full" spacing="$2">
      {props.children}
      <HStack spacing="$2" w="$full">
        <SelectWrapper
          onChange={(name: string) => {
            replace(name)
          }}
          value={objStore.obj.name}
          options={videos.map((obj) => ({ value: obj.name }))}
        />
        <Switch
          css={{
            whiteSpace: "nowrap",
          }}
          defaultChecked={autoNext === "true"}
          onChange={(e) => {
            props.onAutoNextChange(e.currentTarget.checked)
            localStorage.setItem(
              "video_auto_next",
              e.currentTarget.checked.toString(),
            )
          }}
        >
          {t("home.preview.auto_next")}
        </Switch>
      </HStack>
      <Flex wrap="wrap" gap="$1" justifyContent="center" alignItems="center">
        <For each={platformPlayers()}>
          {(item) => {
            return (
              <Tooltip placement="top" withArrow label={item.name}>
                <Anchor
                  // external
                  href={convertURL(item.scheme, {
                    raw_url: objStore.raw_url,
                    name: objStore.obj.name,
                    d_url: currentObjLink(true),
                  })}
                >
                  <Image
                    m="0 auto"
                    boxSize="$8"
                    src={`${window.__dynamic_base__}/images/${item.icon}.webp`}
                  />
                </Anchor>
              </Tooltip>
            )
          }}
        </For>
        <IconButton
          aria-label="Show all players"
          variant="ghost"
          onClick={() => {
            const newShowAll = !showAll()
            setShowAll(newShowAll)
            localStorage.setItem(
              "video_show_all_players",
              newShowAll.toString(),
            )
          }}
          icon={
            <Icon
              as={BsArrowRight}
              boxSize="$6"
              color="accent.500"
              transform={showAll() ? "rotate(180deg)" : "none"}
              transition="transform 0.2s"
            />
          }
        />
      </Flex>
    </VStack>
  )
}
