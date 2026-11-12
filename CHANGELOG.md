# Changelog

## [0.3.0](https://github.com/aimuzov/chatmeld/compare/v0.2.0...v0.3.0) (2026-11-12)


### Features

* expand Chatmeld messaging and history support ([cb7ebf2](https://github.com/aimuzov/chatmeld/commit/cb7ebf2ea594bc78ddf53988ff23c55768d7afcc))
* expose chat profile links and bot markers ([629d620](https://github.com/aimuzov/chatmeld/commit/629d6205fe4c29ff9b56ecddc674f51bcf0dd8da)), closes [#18](https://github.com/aimuzov/chatmeld/issues/18)
* expose message delivery and read receipts ([28e6221](https://github.com/aimuzov/chatmeld/commit/28e622168e27b9e56032a197eab00597b1069e07)), closes [#16](https://github.com/aimuzov/chatmeld/issues/16)
* paginate message history across providers ([8920887](https://github.com/aimuzov/chatmeld/commit/8920887435790c2dbeb588ee5a52106d06544669)), closes [#15](https://github.com/aimuzov/chatmeld/issues/15)
* support Telegram and WhatsApp proxies ([5feb054](https://github.com/aimuzov/chatmeld/commit/5feb0543f7e5c172e5800f82867bd7f6ecc47856)), closes [#19](https://github.com/aimuzov/chatmeld/issues/19)
* **vk:** support community messaging and voice attachments ([d949ac9](https://github.com/aimuzov/chatmeld/commit/d949ac9139c20402302dd9dde971a9c221915d1f)), closes [#20](https://github.com/aimuzov/chatmeld/issues/20)


### Bug Fixes

* **max:** restore forwarded messages ([d123ca7](https://github.com/aimuzov/chatmeld/commit/d123ca70327542352af46a91fc03e0d5a5ddb502))
* **max:** restore text and attachments from forwarded messages ([3f0a3dd](https://github.com/aimuzov/chatmeld/commit/3f0a3dd6a7f9be64c3cba1fefd378c57e46187a7)), closes [#27](https://github.com/aimuzov/chatmeld/issues/27)
* **telegram:** reuse loaded dialogs for avatar requests ([278007a](https://github.com/aimuzov/chatmeld/commit/278007aad1a769a1955448c0864f0994b62e6ddc)), closes [#14](https://github.com/aimuzov/chatmeld/issues/14)
* validate history and proxy options ([61b7b4b](https://github.com/aimuzov/chatmeld/commit/61b7b4bb7c3ad36aa7adb7597815f0a70f92f4b1))
* **vk:** refresh expired personal account tokens ([71110af](https://github.com/aimuzov/chatmeld/commit/71110af0d2e83b7da66f58a3914c4ea128d99b1e))
* **vk:** refresh expired personal account tokens ([88c613b](https://github.com/aimuzov/chatmeld/commit/88c613b2176fb52f27407ddc00d12046ac867dcb)), closes [#29](https://github.com/aimuzov/chatmeld/issues/29)
* **vk:** verify each refresh token candidate ([f0ad48b](https://github.com/aimuzov/chatmeld/commit/f0ad48b4b69cebc3385f9c3c47bd332baa0a01f9)), closes [#29](https://github.com/aimuzov/chatmeld/issues/29)
* **whatsapp:** reject proxies on unsupported Node versions ([8ee6ee0](https://github.com/aimuzov/chatmeld/commit/8ee6ee02ca8f11bfd23a74d8f085b26bfaf58f8b)), closes [#19](https://github.com/aimuzov/chatmeld/issues/19)
* **whatsapp:** send serializable worker options ([f9c7138](https://github.com/aimuzov/chatmeld/commit/f9c7138d516adc611ff6912a00051af9885c5242)), closes [#17](https://github.com/aimuzov/chatmeld/issues/17)

## [0.2.0](https://github.com/aimuzov/chatmeld/compare/v0.1.1...v0.2.0) (2026-11-03)


### Features

* add Instagram, avatars and media messaging ([0f4ebd7](https://github.com/aimuzov/chatmeld/commit/0f4ebd7334c6fcc309968990480aa7174a3bbe72))
* add Instagram, avatars and media messaging ([aaa200f](https://github.com/aimuzov/chatmeld/commit/aaa200f5f036efd1990bb11630fce38880bd6590))


### Bug Fixes

* keep connections open for unavailable media ([1133c98](https://github.com/aimuzov/chatmeld/commit/1133c98e86803b9c495afd5ce0aaea0a836e11b3))
* preserve Telegram connection after download size limit ([1906b3e](https://github.com/aimuzov/chatmeld/commit/1906b3ec04c811e12917f2a7a970e51da9cdbc4a))

## [0.1.1](https://github.com/aimuzov/chatmeld/compare/v0.1.0...v0.1.1) (2026-11-03)


### Bug Fixes

* **docs:** correct quickstart and npm publishing instructions ([add14a7](https://github.com/aimuzov/chatmeld/commit/add14a79692764e7394488ed4c2c18e7de344bf5))
* **docs:** load Node types in TypeScript quickstart ([3190453](https://github.com/aimuzov/chatmeld/commit/3190453c4eb235139b1d5bad12a1084ee4c3d87d))

## 0.1.0 (2026-11-03)


### Features

* introduce Chatmeld messaging library ([92c8a3c](https://github.com/aimuzov/chatmeld/commit/92c8a3c53c4d03d18a4dc3d644a8cbc59aa8e026))
* load recent Telegram and VK messages ([6e7cbd7](https://github.com/aimuzov/chatmeld/commit/6e7cbd74151b4a7b76238928c14e4813fcdec54b))
* prepare Chatmeld for npm and automated releases ([53eb4ea](https://github.com/aimuzov/chatmeld/commit/53eb4ea11be3e43f2c568b983e31ef9ff2254802))
* prepare scoped npm package and automated releases ([244ecd1](https://github.com/aimuzov/chatmeld/commit/244ecd1a78d96fd299edf93d4f45e2e9920a4030))


### Bug Fixes

* **readme:** match banners to SiteKit visual style ([2a4c6fd](https://github.com/aimuzov/chatmeld/commit/2a4c6fd3c23f7895bd41e6091a01e5fba16725c6))
