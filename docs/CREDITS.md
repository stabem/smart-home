# Credits

Assets are available offline after installation. Font binaries are downloaded directly from Fontshare during `npm ci` into the ignored `src/renderer/assets/fonts/` folder; they are never committed to this repository. If Fontshare is unavailable, installation succeeds with system-font fallbacks. The app makes no runtime request to an asset host.

| Asset | Source | License | Use |
|---|---|---|---|
| Switzer 400, 500, 600 | [Fontshare / Switzer](https://www.fontshare.com/fonts/switzer) | [ITF Free Font License 2.0](https://www.fontshare.com/licenses/itf-ffl) | UI, self-hosted in this desktop app |
| Zodiak 400 | [Fontshare / Zodiak](https://www.fontshare.com/fonts/zodiak) | [ITF Free Font License 2.0](https://www.fontshare.com/licenses/itf-ffl) | Installed offline for compatibility with earlier builds; the widget uses Switzer |
| Scan and bulb Lottie animations (air.lottie removed in #53; AC wind is CSS) · Light bulb, snowflake, settings, home, back arrow, air conditioner icons | [Iconoir](https://github.com/iconoir-icons/iconoir/tree/main/icons/regular) | [MIT](https://github.com/iconoir-icons/iconoir/blob/main/LICENSE) | Consistent line icon set |
| Bulb animation | [Niki Wen on LottieFiles](https://lottiefiles.com/free-animation/light-bulb-b0NdfpX0z6) | [Lottie Simple License](https://lottiefiles.com/page/license) | Light-on feedback |
| Airflow animation | [animation free on LottieFiles](https://lottiefiles.com/free-animation/wind-R4uGeQH3Js) | [Lottie Simple License](https://lottiefiles.com/page/license) | AC airflow feedback |
| Loading animation | [LottieFiles](https://lottiefiles.com/free-animation/loading-zXKnUvIt1H) | [Lottie Simple License](https://lottiefiles.com/page/license) | Device scan |

The Lottie animations remain subject to the Lottie Simple License when redistributed; its full text is included at `src/renderer/assets/lottie/LICENSE.md`. The Fontshare fonts are fetched by each installer from Fontshare's public CSS/CDN under its terms; anyone using the font files separately must obtain their own copy from Fontshare. The Iconoir icon files retain their MIT license.
