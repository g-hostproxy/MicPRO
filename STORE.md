# Publishing MicPRO on the Microsoft Store

Everything the Store needs is in this repo: the package build, tile icons, screenshots, logo, listing text and privacy policy. What's left are the steps only you can do in Partner Center.

## 1. Create your developer account (free)

1. Go to https://storedeveloper.microsoft.com and choose **Get started** → **Individual**.
2. Sign in with your personal Microsoft account and complete ID verification (ID and selfie).
3. In Partner Center, open **Account settings → Payout and tax** and fill in your payout and tax details. You can't get paid for a paid app until this is done.

## 2. Reserve the name

**Apps and games → New product → MSIX or PWA app**, enter `MicPRO`, then **Check availability** and **Reserve**. If it's taken, try `MicPRO Voice` and change `appx.displayName` in `app/package.json` to match.

## 3. Build the Store package

1. In Partner Center, open your app → **Product management → Product identity**. Copy these three values:
   - `Package/Identity/Name`
   - `Package/Identity/Publisher` (starts with `CN=`)
   - `Package/Properties/PublisherDisplayName`
2. On GitHub: **Actions → Build Microsoft Store package → Run workflow**, paste the three values, and run it.
3. When it finishes, download the **MicPRO-Store-package** artifact from the run page and unzip it. You'll upload the `.appx` inside it.

You don't need a code-signing certificate, because Microsoft signs Store packages for you.

## 4. Fill in the submission

### Pricing and availability
- **Base price:** your choice. Microsoft keeps 15% of sales of non-game apps made through its commerce system.
- **Free trial:** optional. "1 week" lets people confirm it works with their mic before paying.
- **Markets:** all markets.

### Properties
- **Category:** Music (secondary: Utilities & tools)
- **Privacy policy URL:** the public address of `privacy.html` (for example `https://g-hostproxy.github.io/MicPRO/privacy.html`). It must stay reachable after the repo goes private; see "Going Store-only" below.
- **Website:** the public address of `index.html`.
- **Support contact:** an email address you're happy to show publicly. The privacy policy tells people to use this contact.
- **System requirements:** Microphone required. Hardware: x64.

### Age ratings
Answer the questionnaire truthfully. MicPRO has no user-generated content shared through the app, no chat of its own, no purchases inside the app and no location sharing.

### Packages
Upload the `.appx` from step 3.

### Store listing (English)

**Description** (the first paragraph is required by Store policy 10.2.4 because MicPRO depends on a third-party virtual audio driver):

> Requires a virtual audio cable to send your voice to other apps: install the free VB-CABLE from VB-Audio (vb-audio.com/Cable) to use MicPRO as your mic in Discord, OBS and games. Without it, MicPRO still processes, monitors and records your voice.
>
> MicPRO makes the microphone you already own sound like a studio, live, and turns your voice into someone else's.
>
> CLEAN VOICE
> • Spectral noise reduction that learns your room and PC fan noise
> • Smooth noise gate, so keyboard clatter stays out between sentences
> • Drag-to-shape EQ: cut mud and boom, add clarity and air
> • De-esser, warmth, compressor and limiter, so every callout lands at one level and never clips
> • Auto-set gain: talk for five seconds and MicPRO sets your level
> • Presets for popular broadcast dynamic mics and gaming headsets, plus Clean Streamer and Movie Voiceover
>
> VOICE CHANGER
> • Walkie-Talkie, Tactical Comms and Field Radio: real radio behaviour, with a key-up click when you talk, static, crackle and a squelch tail when you stop
> • Girl and God: pitch and formant shifting for convincing voices, with a deep rumble and huge hall reverb for God
> • Blown Out: maximum-distortion meme mic
> • Hotkey to switch the voice changer on and off mid-game
>
> MADE FOR CREATORS
> • Record a test take and compare raw against processed
> • Save 24-bit WAV voiceovers for your edits
> • Low-latency headphone monitoring
> • Remembers your devices, and switches back when you plug your mic in again
>
> Everything runs on your PC. No account, no cloud, no tracking.
>
> MicPRO is not affiliated with Shure, Logitech or VB-Audio.

**Short description:** Studio-clean mic and real-time voice changer for streaming and gaming.

**What's new in this version:** Lower-latency headphone monitoring. MicPRO now turns on when it opens and remembers your devices.

**Search terms** (up to 7; Store guidance says not to use other companies' brand names here):
`voice changer`, `noise suppression`, `mic enhancer`, `noise gate`, `streaming`, `radio voice`, `podcast`

**Screenshots:** upload `store/screenshots/*.png` (1920×1080).
**Store logo:** `store/logo-1080.png` (1:1); `store/logo-300.png` if a smaller one is asked for.

### Submission options → Notes for certification

Paste this:

> MicPRO is a real-time microphone processor and voice changer. It does not include or install any driver. To route processed audio into other apps, users can optionally install the third-party VB-CABLE virtual audio driver from VB-Audio (disclosed at the top of the description, per policy 10.2.4). Core functionality works without it.
>
> How to test without VB-CABLE:
> 1. Launch MicPRO. Processing starts automatically and uses the default microphone.
> 2. Speak: the spectrum and meters respond.
> 3. Turn on "Listen in headphones" to hear the processed voice, or press "Record test", speak, press "Stop", and play back "Raw mic" against "MicPRO".
> 4. Pick any voice under "Voice changer" (for example "Walkie-Talkie" or "God") and repeat step 3.

## 5. Submit

Select **Submit for certification**. Reviews usually take a few business days. If Microsoft asks about the VB-CABLE dependency, point to the certification notes above: MicPRO does not install or bundle the driver.

## Going Store-only (private code)

Do these in order, so there's never a moment with no way to get MicPRO:

1. **Wait until the Store listing is live.** In Partner Center, under Product identity, copy the **Store URL** (`https://apps.microsoft.com/detail/...`).
2. **Set the Store link on the website:** put that URL in `STORE_URL` near the bottom of `index.html` and push. Every Get MicPRO button then opens the Store.
3. **Keep the website public.** GitHub Pages doesn't serve private repos on a free GitHub plan. Either:
   - create a small public repo (for example `micpro-site`) with `index.html`, `privacy.html` and `assets/`, and turn on Pages there, or
   - upgrade to GitHub Pro, which keeps Pages working from this private repo.
   If the site's address changes, update the privacy policy URL and website in Partner Center.
4. **Make this repo private:** GitHub → MicPRO → Settings → General → Danger Zone → Change visibility → Private. The old free releases (v1.0–v1.3.1) stop being downloadable from GitHub at the same moment.

Free installers are no longer published: the release workflow now only builds test installers on demand.

## Updating later

Bump `version` in `app/package.json`, run the **Build Microsoft Store package** workflow again with the same three values, and create a new submission in Partner Center with the new `.appx`.
