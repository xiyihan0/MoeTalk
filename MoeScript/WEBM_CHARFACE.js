/*@MoeScript/WEBM_CHARFACE.js@*/
(function() {
	"use strict";

	const userConfig = window.mtWebMCharFaceConfig || {};
	const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
	const imageSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");
	const originalSetAttribute = Element.prototype.setAttribute;
	const originalFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
	const state = {
		manifest: null,
		manifestPromise: null,
		assetRoot: null,
		videos: new Map(),
		fallbacks: new Set(),
		observer: null,
		manifestWarned: false,
		srcPatched: false,
		fetchPatched: false
	};

	const api = {
		enabled: localStorage.getItem("mt_webm_charface") !== "0" && userConfig.enabled !== false,
		fps: 10,
		getManifestUrls,
		loadManifest,
		getKnownFrames,
		getFrameDataUrl,
		applyToImage,
		scanNode,
		start,
		normalizeSource
	};

	window.MoeTalkWebMCharFace = api;

	if(!api.enabled)return;

	patchImageSourceHooks();
	patchFetchHook();

	if(document.readyState === "loading")
	{
		document.addEventListener("DOMContentLoaded", start, {once: true});
	}
	else start();

	function getManifestUrls()
	{
		const configured = userConfig.manifestUrl;
		if(Array.isArray(configured) && configured.length)return configured.slice();
		if(configured)return [configured];

		const candidates = [
			"webm-charface-assets/manifest.json"
		];
		const urls = [];
		for(let i = 0,l = candidates.length;i < l;i++)
		{
			try
			{
				urls.push(new URL(candidates[i], window.location.href).href);
			}
			catch(error)
			{
				urls.push(candidates[i]);
			}
		}
		return Array.from(new Set(urls));
	}

	async function loadManifest()
	{
		if(state.manifest)return state.manifest;
		if(state.manifestPromise)return state.manifestPromise;

		state.manifestPromise = (async function()
		{
			let lastError = null;
			const manifestUrls = getManifestUrls();
			for(let i = 0,l = manifestUrls.length;i < l;i++)
			{
				const manifestUrl = manifestUrls[i];
				try
				{
					const response = await originalFetch(manifestUrl,
					{
						cache: "no-store"
					});
					if(!response.ok)throw new Error("Manifest request failed: " + response.status + " @ " + manifestUrl);
					const manifest = await response.json();
					state.manifest = manifest;
					state.assetRoot = new URL("./", manifestUrl).href;
					api.fps = manifest.framerate || api.fps;
					return manifest;
				}
				catch(error)
				{
					lastError = error;
				}
			}

			if(!state.manifestWarned)
			{
				state.manifestWarned = true;
				console.warn("[WEBM_CHARFACE] manifest unavailable", lastError);
			}
			state.manifest = null;
			state.assetRoot = null;
			return null;
		})();

		return state.manifestPromise;
	}

	function normalizeDirectorySource(source)
	{
		if(!source)return null;
		let raw = String(source);
		let matchIndex = raw.lastIndexOf("GameData/");
		if(matchIndex < 0)return null;
		let normalized = raw.slice(matchIndex).split("?")[0].split("#")[0].replaceAll("\\","/");
		if(!normalized.includes("/CharFace/"))return null;
		if(normalized.endsWith("/"))normalized = normalized.slice(0,-1);
		try
		{
			normalized = decodeURIComponent(normalized);
		}
		catch(error)
		{
			// keep raw value when decodeURIComponent fails
		}
		return normalized;
	}

	function normalizeSource(source)
	{
		let normalized = normalizeDirectorySource(source);
		if(!normalized)return null;
		if(!normalized.toLowerCase().endsWith(".webp"))return null;
		return normalized;
	}

	function getKnownFrames(source)
	{
		const manifest = state.manifest;
		const dirKey = normalizeDirectorySource(source);
		if(!manifest || !dirKey)return null;
		const dirInfo = manifest.dirs && manifest.dirs[dirKey];
		if(!dirInfo || !Array.isArray(dirInfo.frames) || !dirInfo.frames.length)return null;
		return dirInfo.frames.slice();
	}

	function getFrameInfoFromManifest(source)
	{
		const manifest = state.manifest;
		const normalized = normalizeSource(source);
		if(!manifest || !normalized)return null;

		const lastSlash = normalized.lastIndexOf("/");
		if(lastSlash < 0)return null;
		const dirKey = normalized.slice(0,lastSlash);
		const frameName = normalized.slice(lastSlash + 1).replace(/\.webp$/i,"");
		const dirInfo = manifest.dirs && manifest.dirs[dirKey];
		if(!dirInfo || !Array.isArray(dirInfo.frames) || !dirInfo.frames.length)
		{
			return {
				normalized: normalized,
				missing: true
			};
		}

		if(!dirInfo._frameMap)
		{
			dirInfo._frameMap = {};
			for(let i = 0,l = dirInfo.frames.length;i < l;i++)
			{
				dirInfo._frameMap[dirInfo.frames[i]] = i;
			}
		}

		if(dirInfo._frameMap[frameName] === undefined)
		{
			return {
				normalized: normalized,
				missing: true
			};
		}

		return {
			normalized: normalized,
			missing: false,
			frameIndex: dirInfo._frameMap[frameName],
			videoUrl: resolveVideoUrl(dirInfo.video)
		};
	}

	function setImageSourceDirect(image,source)
	{
		if(!image || !imageSrcDescriptor || !imageSrcDescriptor.set)return;
		image.dataset.webmCharfaceBypass = "1";
		try
		{
			imageSrcDescriptor.set.call(image,source);
		}
		finally
		{
			delete image.dataset.webmCharfaceBypass;
		}
	}

	function setImageAttributeDirect(image,source)
	{
		if(!image)return;
		image.dataset.webmCharfaceBypass = "1";
		try
		{
			originalSetAttribute.call(image,"src",source);
		}
		finally
		{
			delete image.dataset.webmCharfaceBypass;
		}
	}

	function queueImageReplacement(image,source,forceBlank = true)
	{
		const normalized = normalizeSource(source);
		if(!normalized)return false;
		if(image.dataset.webmCharfaceState === "fallback" && image.dataset.webmCharfaceSource === normalized)return false;
		const frameInfo = getFrameInfoFromManifest(source);
		if(frameInfo && frameInfo.missing)
		{
			image.dataset.webmOriginalSrc = source;
			image.dataset.webmCharfaceSource = normalized;
			image.dataset.webmCharfaceState = "fallback";
			return false;
		}

		const requestId = String((parseInt(image.dataset.webmRequestId || "0",10) || 0) + 1);
		image.dataset.webmRequestId = requestId;
		image.dataset.webmOriginalSrc = source;
		image.dataset.webmCharfaceSource = normalized;
		image.dataset.webmCharfaceState = "processing";

		if(forceBlank)
		{
			setImageSourceDirect(image,BLANK_IMAGE);
			setImageAttributeDirect(image,BLANK_IMAGE);
		}

		Promise.resolve().then(async function()
		{
			const dataUrl = await getFrameDataUrl(source);
			if(image.dataset.webmRequestId !== requestId)return;

			if(dataUrl)
			{
				image.dataset.webmCharfaceState = "done";
				syncFallbackCache(normalized,dataUrl);
				setImageSourceDirect(image,dataUrl);
				setImageAttributeDirect(image,dataUrl);
				return;
			}

			image.dataset.webmCharfaceState = "fallback";
			setImageSourceDirect(image,source);
			setImageAttributeDirect(image,source);
		}).catch(function(error)
		{
			if(image.dataset.webmRequestId !== requestId)return;
			image.dataset.webmCharfaceState = "fallback";
			console.warn("[WEBM_CHARFACE] queued replacement failed", error);
			setImageSourceDirect(image,source);
			setImageAttributeDirect(image,source);
		});

		return true;
	}

	function patchImageSourceHooks()
	{
		if(state.srcPatched || !imageSrcDescriptor || !imageSrcDescriptor.set)return;

		Object.defineProperty(HTMLImageElement.prototype,"src",
		{
			configurable: imageSrcDescriptor.configurable,
			enumerable: imageSrcDescriptor.enumerable,
			get: imageSrcDescriptor.get,
			set: function(value)
			{
				if(this.dataset && this.dataset.webmCharfaceBypass === "1")
				{
					imageSrcDescriptor.set.call(this,value);
					return;
				}
				if(queueImageReplacement(this,value))return;
				imageSrcDescriptor.set.call(this,value);
			}
		});

		Element.prototype.setAttribute = function(name,value)
		{
			if(this && this.tagName === "IMG" && String(name).toLowerCase() === "src")
			{
				if(this.dataset && this.dataset.webmCharfaceBypass === "1")
				{
					return originalSetAttribute.call(this,name,value);
				}
				if(queueImageReplacement(this,value))return;
			}
			return originalSetAttribute.call(this,name,value);
		};

		state.srcPatched = true;
	}

	function patchFetchHook()
	{
		if(state.fetchPatched || !originalFetch)return;

		window.fetch = async function(input,init)
		{
			const requestMethod = getFetchMethod(input,init);
			if(requestMethod && requestMethod !== "GET")return originalFetch(input,init);

			const source = getFetchSource(input);
			const normalized = normalizeSource(source);
			if(!normalized)return originalFetch(input,init);

			const dataUrl = await getFrameDataUrl(source);
			if(!dataUrl)return originalFetch(input,init);

			syncFallbackCache(normalized,dataUrl);
			return createFetchResponse(dataUrl, normalized);
		};

		state.fetchPatched = true;
	}

	function getFetchMethod(input,init)
	{
		const method = init && init.method || input && input.method || "GET";
		return String(method).toUpperCase();
	}

	function getFetchSource(input)
	{
		if(!input)return null;
		if(typeof Request !== "undefined" && input instanceof Request)return input.url;
		if(typeof URL !== "undefined" && input instanceof URL)return input.href;
		return String(input);
	}

	async function createFetchResponse(dataUrl,source)
	{
		const response = await originalFetch(dataUrl);
		if(!response.ok)return response;

		const blob = await response.blob();
		return new Response(blob,
		{
			status: 200,
			statusText: "OK",
			headers:
			{
				"Content-Type": blob.type || "image/png",
				"Cache-Control": "public, max-age=31536000, immutable",
				"X-MT-WebM-CharFace": "1",
				"X-MT-WebM-CharFace-Source": source
			}
		});
	}

	async function resolveFrameInfo(source)
	{
		const manifest = await loadManifest();
		if(!manifest)return null;
		const frameInfo = getFrameInfoFromManifest(source);
		if(!frameInfo || frameInfo.missing)return null;
		return {
			frameIndex: frameInfo.frameIndex,
			videoUrl: frameInfo.videoUrl
		};
	}

	function resolveVideoUrl(videoPath)
	{
		const rawPath = String(videoPath || "").replaceAll("\\","/");
		const fileName = rawPath.split("/").pop();
		if(state.assetRoot && fileName)
		{
			try
			{
				return new URL(fileName, state.assetRoot).href;
			}
			catch(error)
			{
				// fall back to the raw path below
			}
		}
		return new URL(rawPath, window.location.href).href;
	}

	function getVideoEntry(videoUrl)
	{
		if(state.videos.has(videoUrl))return state.videos.get(videoUrl);

		const video = document.createElement("video");
		video.preload = "auto";
		video.muted = true;
		video.playsInline = true;
		video.crossOrigin = "anonymous";
		video.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;pointer-events:none;";
		(document.body || document.documentElement).appendChild(video);

		const entry = {
			videoUrl: videoUrl,
			video: video,
			cache: new Map(),
			queue: Promise.resolve(),
			canvas: document.createElement("canvas"),
			ctx: null
		};
		entry.ctx = entry.canvas.getContext("2d");
		entry.readyPromise = new Promise(function(resolve,reject)
		{
			let resolved = false;
			function cleanup()
			{
				video.removeEventListener("loadedmetadata", onReady);
				video.removeEventListener("loadeddata", onReady);
				video.removeEventListener("error", onError);
			}
			function onReady()
			{
				if(resolved)return;
				resolved = true;
				cleanup();
				resolve(video);
			}
			function onError()
			{
				cleanup();
				reject(new Error("Video load failed: " + videoUrl));
			}
			video.addEventListener("loadedmetadata", onReady);
			video.addEventListener("loadeddata", onReady);
			video.addEventListener("error", onError);
		});

		video.src = videoUrl;
		video.load();
		state.videos.set(videoUrl, entry);
		return entry;
	}

	function syncFallbackCache(source,dataUrl)
	{
		if(!source || !dataUrl || !navigator.serviceWorker)return;
		let absoluteUrl = "";
		try
		{
			absoluteUrl = new URL(source, window.location.href).href;
		}
		catch(error)
		{
			return;
		}
		if(state.fallbacks.has(absoluteUrl))return;
		state.fallbacks.add(absoluteUrl);

		const payload = {
			type: "MT_WEBM_CHARFACE_CACHE_PUT",
			url: absoluteUrl,
			dataUrl: dataUrl
		};

		Promise.resolve(navigator.serviceWorker.ready).then(function(registration)
		{
			const target = navigator.serviceWorker.controller || registration.active || registration.waiting;
			if(!target)
			{
				state.fallbacks.delete(absoluteUrl);
				return;
			}
			target.postMessage(payload);
		}).catch(function()
		{
			state.fallbacks.delete(absoluteUrl);
		});
	}

	async function captureFrame(entry,frameIndex)
	{
		const video = entry.video;
		await entry.readyPromise;
		const fps = api.fps || 10;
		const seekTime = frameIndex <= 0 ? 0 : frameIndex / fps + 0.00001;
		await new Promise(function(resolve,reject)
		{
			let timeoutId = 0;

			function cleanup()
			{
				video.removeEventListener("seeked", onSeeked);
				video.removeEventListener("error", onError);
				if(timeoutId)clearTimeout(timeoutId);
			}

			function onSeeked()
			{
				cleanup();
				resolve();
			}

			function onError()
			{
				cleanup();
				reject(new Error("Video seek failed"));
			}

			video.pause();
			if(Math.abs(video.currentTime - seekTime) < 0.0001 && video.readyState >= 2)
			{
				resolve();
				return;
			}

			timeoutId = setTimeout(function()
			{
				cleanup();
				reject(new Error("Video seek timeout"));
			}, 10000);

			video.addEventListener("seeked", onSeeked);
			video.addEventListener("error", onError);
			video.currentTime = seekTime;
		});

		if(entry.canvas.width !== video.videoWidth || entry.canvas.height !== video.videoHeight)
		{
			entry.canvas.width = video.videoWidth;
			entry.canvas.height = video.videoHeight;
		}

		entry.ctx.clearRect(0,0,entry.canvas.width,entry.canvas.height);
		entry.ctx.drawImage(video,0,0);
		return entry.canvas.toDataURL("image/png");
	}

	async function getFrameDataUrl(source)
	{
		const frameInfo = await resolveFrameInfo(source);
		if(!frameInfo)return null;

		const entry = getVideoEntry(frameInfo.videoUrl);
		if(entry.cache.has(frameInfo.frameIndex))return entry.cache.get(frameInfo.frameIndex);

		entry.queue = entry.queue.then(async function()
		{
			if(entry.cache.has(frameInfo.frameIndex))return entry.cache.get(frameInfo.frameIndex);
			const dataUrl = await captureFrame(entry,frameInfo.frameIndex);
			entry.cache.set(frameInfo.frameIndex,dataUrl);
			return dataUrl;
		}).catch(function(error)
		{
			console.warn("[WEBM_CHARFACE] frame extraction failed", error);
			return null;
		});

		return entry.queue;
	}

	async function applyToImage(image)
	{
		if(!image || image.nodeType !== 1 || image.tagName !== "IMG")return;

		const originalSource = image.dataset.webmOriginalSrc || image.getAttribute("src") || image.currentSrc || image.src;
		const normalized = normalizeSource(originalSource);
		if(!normalized)return;
		const frameInfo = getFrameInfoFromManifest(originalSource);
		if(frameInfo && frameInfo.missing)
		{
			image.dataset.webmOriginalSrc = originalSource;
			image.dataset.webmCharfaceSource = normalized;
			image.dataset.webmCharfaceState = "fallback";
			return;
		}
		if(image.dataset.webmCharfaceState === "processing" && image.dataset.webmCharfaceSource === normalized)return;
		if(image.dataset.webmCharfaceState === "done" && image.dataset.webmCharfaceSource === normalized)return;
		if(image.dataset.webmCharfaceState === "fallback" && image.dataset.webmCharfaceSource === normalized)return;
		queueImageReplacement(image,originalSource,false);
	}

	function scanNode(node)
	{
		if(!node || node.nodeType !== 1)return;
		if(node.tagName === "IMG")applyToImage(node);
		if(node.querySelectorAll)
		{
			node.querySelectorAll("img").forEach(function(image)
			{
				applyToImage(image);
			});
		}
	}

	function patchImageError()
	{
		if(typeof window.IMAGE_error !== "function" || window.IMAGE_error._webmPatched)return;

		const original = window.IMAGE_error;
		const patched = async function(image,play)
		{
			const target = image && image.target ? image.target : image;
			if(target)
			{
				const originalSource = target.dataset && target.dataset.webmOriginalSrc ? target.dataset.webmOriginalSrc : target.getAttribute && target.getAttribute("src") || target.src;
				const normalized = normalizeSource(originalSource);
				const frameInfo = getFrameInfoFromManifest(originalSource);
				if(frameInfo && frameInfo.missing)
				{
					target.dataset.webmOriginalSrc = originalSource;
					target.dataset.webmCharfaceSource = normalized || "";
					target.dataset.webmCharfaceState = "fallback";
					return original.apply(this,arguments);
				}
				if(normalized && target.dataset && target.dataset.webmCharfaceState === "fallback" && target.dataset.webmCharfaceSource === normalized)
				{
					return original.apply(this,arguments);
				}
				const dataUrl = await getFrameDataUrl(originalSource);
				if(dataUrl)
				{
					target.dataset.webmCharfaceState = "done";
					if(!target.dataset.webmOriginalSrc)target.dataset.webmOriginalSrc = originalSource;
					setImageSourceDirect(target,dataUrl);
					setImageAttributeDirect(target,dataUrl);
					return;
				}
			}
			return original.apply(this,arguments);
		};

		patched._webmPatched = true;
		window.IMAGE_error = patched;
	}

	function start()
	{
		patchImageError();
		loadManifest().catch(function()
		{
			return null;
		});
		scanNode(document.documentElement);

		state.observer = new MutationObserver(function(records)
		{
			records.forEach(function(record)
			{
				if(record.type === "attributes")
				{
					applyToImage(record.target);
					return;
				}

				record.addedNodes.forEach(function(node)
				{
					scanNode(node);
				});
			});
		});

		state.observer.observe(document.documentElement,
		{
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["src"]
		});
	}
})();
