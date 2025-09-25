import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";

const SERVER_URL =
   process.env.REACT_APP_API_URL ||
   (window.location.protocol === "https:"
      ? "https://dev.be.msp.sevago.local"
      : "http://localhost:7003");

function App() {
   const [socket, setSocket] = useState(null);
   const [device, setDevice] = useState(null);
   const [sendTransport, setSendTransport] = useState(null);
   const [recvTransport, setRecvTransport] = useState(null);
   const [joined, setJoined] = useState(false);
   const [roomId, setRoomId] = useState("");
   const [peers, setPeers] = useState([]);
   const [localStream, setLocalStream] = useState(null);
   const [videoProducer, setVideoProducer] = useState(null);
   const [audioProducer, setAudioProducer] = useState(null);
   const [screenProducer, setScreenProducer] = useState(null);
   const [consumers, setConsumers] = useState(new Map());
   const localVideoRef = useRef(null);
   const deviceRef = useRef(null);
   const recvTransportRef = useRef(null);

   // Debug functions
   const debugMediaStream = (stream, label) => {
      console.log(`=== ${label} ===`);
      console.log("Stream active:", stream.active);
      console.log("Stream id:", stream.id);

      const tracks = stream.getTracks();
      tracks.forEach((track, index) => {
         console.log(`Track ${index}:`, {
            kind: track.kind,
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
            label: track.label,
            settings: track.getSettings ? track.getSettings() : "N/A",
         });
      });
   };

   const debugVideoElement = (videoElement, label) => {
      console.log(`=== Video Element ${label} ===`);
      console.log("Video src:", videoElement.src);
      console.log("Video srcObject:", videoElement.srcObject);
      console.log("Video readyState:", videoElement.readyState);
      console.log("Video networkState:", videoElement.networkState);
      console.log("Video paused:", videoElement.paused);
      console.log("Video muted:", videoElement.muted);
      console.log("Video autoplay:", videoElement.autoplay);
      console.log("Video width x height:", videoElement.videoWidth, "x", videoElement.videoHeight);
      console.log("Video in DOM:", document.body.contains(videoElement));
   };

   const debugVideoTrack = (track) => {
      console.log("Video track info:", {
         kind: track.kind,
         enabled: track.enabled,
         muted: track.muted,
         readyState: track.readyState,
         settings: track.getSettings ? track.getSettings() : "N/A",
      });
   };

   useEffect(() => {
      const newSocket = io(SERVER_URL);
      setSocket(newSocket);

      newSocket.on("connect", () => {
         console.log("Connected to server:", newSocket.id);
      });

      newSocket.on("new-peer", ({ peerId }) => {
         setPeers((prevPeers) => [...prevPeers, peerId]);
         console.log("New peer:", peerId);
      });

      newSocket.on("peer-left", ({ peerId }) => {
         setPeers((prevPeers) => prevPeers.filter((id) => id !== peerId));
         console.log("Peer left:", peerId);
      });

      return () => {
         newSocket.close();
      };
   }, []);

   const createDevice = async (rtpCapabilities) => {
      const newDevice = new mediasoupClient.Device();
      await newDevice.load({ routerRtpCapabilities: rtpCapabilities });
      setDevice(newDevice);
      deviceRef.current = newDevice;
      return newDevice;
   };

   const createSendTransport = (device, transportOptions) => {
      console.log(device);
      const newSendTransport = device.createSendTransport(transportOptions);
      newSendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
         try {
            socket.emit("connect-transport", {
               transportId: newSendTransport.id,
               dtlsParameters,
               roomId,
               peerId: socket.id,
            });
            callback();
         } catch (error) {
            errback(error);
         }
      });

      newSendTransport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
         try {
            socket.emit(
               "produce",
               {
                  transportId: newSendTransport.id,
                  kind,
                  rtpParameters,
                  roomId,
                  peerId: socket.id,
               },
               (producerId) => {
                  callback({ id: producerId });
               }
            );
         } catch (error) {
            errback(error);
         }
      });
      setSendTransport(newSendTransport);
      return newSendTransport;
   };

   const createRecvTransport = (device, transportOptions) => {
      const newRecvTransport = device.createRecvTransport(transportOptions);
      newRecvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
         try {
            socket.emit("connect-transport", {
               transportId: newRecvTransport.id,
               dtlsParameters,
               roomId,
               peerId: socket.id,
            });
            callback();
         } catch (error) {
            errback(error);
         }
      });
      setRecvTransport(newRecvTransport);
      recvTransportRef.current = newRecvTransport;
      return newRecvTransport;
   };

   const getLocalAudioStreamAndTrack = async () => {
      const audioStream = await navigator.mediaDevices.getUserMedia({
         audio: true,
      });
      const audioTrack = audioStream.getAudioTracks()[0];
      return audioTrack;
   };

   const joinRoom = () => {
      if (!socket || !roomId) return;

      if (window.confirm("bạn có muốn tham gia phòng không?")) {
         socket.emit("join-room", { roomId, peerId: socket.id }, async (response) => {
            if (response.error) {
               console.error("Error joining room:", response.error);
               return;
            }

            const {
               sendTransportOptions,
               recvTransportOptions,
               rtpCapabilities,
               peerIds,
               existingProducers,
            } = response;

            console.log(">> joinRoom response", response);

            const newDevice = await createDevice(rtpCapabilities);
            const newSendTransport = createSendTransport(newDevice, sendTransportOptions);
            const newRecvTransport = createRecvTransport(newDevice, recvTransportOptions);

            socket.on("new-producer", handleNewProducer);

            const audioTrack = await getLocalAudioStreamAndTrack();
            const newAudioProducer = await newSendTransport.produce({
               track: audioTrack,
            });

            setAudioProducer(newAudioProducer);
            setPeers(peerIds.filter((id) => id !== socket.id));
            console.log(">> setPeers", peerIds);

            console.log("Existing producers:", existingProducers);
            for (const producerInfo of existingProducers) {
               console.log("Consuming existing producer:", producerInfo);
               await consume(producerInfo);
            }

            setJoined(true);
         });
      }
   };

   const leaveRoom = () => {
      if (!socket) return;

      socket.emit("leave-room", (response) => {
         if (response && response.error) {
            console.error("Error leaving room:", response.error);
            return;
         }

         setJoined(false);
         setPeers([]);

         consumers.forEach(({ consumer }) => {
            consumer.close();
         });
         setConsumers(new Map());

         const remoteMediaDiv = document.getElementById("remote-media");
         if (remoteMediaDiv) {
            remoteMediaDiv.innerHTML = "";
         }

         if (localStream) {
            localStream.getTracks().forEach((track) => track.stop());
            setLocalStream(null);
         }
         if (sendTransport) {
            sendTransport.close();
            setSendTransport(null);
         }
         if (recvTransport) {
            recvTransport.close();
            setRecvTransport(null);
         }
         if (device) {
            setDevice(null);
         }

         socket.off("new-producer", handleNewProducer);
      });
   };

   const startCamera = async () => {
      if (!sendTransport) return;

      // FIX: Thêm constraints cụ thể để tránh video bị đen
      const stream = await navigator.mediaDevices.getUserMedia({
         video: {
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 30, max: 60 },
         },
         audio: false, // Tách riêng audio vì đã có audioProducer
      });
      setLocalStream(stream);

      if (localVideoRef.current) {
         localVideoRef.current.srcObject = stream;
      }

      const videoTrack = stream.getVideoTracks()[0];
      console.log("Local video track settings:", videoTrack.getSettings());

      const newVideoProducer = await sendTransport.produce({ track: videoTrack });
      setVideoProducer(newVideoProducer);
   };

   const stopCamera = () => {
      if (localStream) {
         localStream.getTracks().forEach((track) => track.stop());
         setLocalStream(null);
      }
      if (localVideoRef.current) {
         localVideoRef.current.srcObject = null;
      }
      if (videoProducer) {
         videoProducer.close();
         setVideoProducer(null);
      }
   };

   const startScreenShare = async () => {
      if (!sendTransport) return;

      const stream = await navigator.mediaDevices.getDisplayMedia({
         video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 15, max: 30 },
         },
         audio: false,
      });
      const screenTrack = stream.getVideoTracks()[0];

      const newScreenProducer = await sendTransport.produce({
         track: screenTrack,
      });
      setScreenProducer(newScreenProducer);

      screenTrack.onended = () => {
         stopScreenShare();
      };
   };

   const stopScreenShare = () => {
      if (screenProducer) {
         screenProducer.close();
         setScreenProducer(null);
      }
   };

   const handleNewProducer = async ({ producerId, peerId, kind }) => {
      await consume({ producerId, peerId, kind });
   };

   const consume = async ({ producerId, peerId, kind }) => {
      console.log(">> consume producerId", producerId);
      console.log(">> consume peerId", peerId);
      console.log(">> consume kind", kind);
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;
      if (!device || !recvTransport) {
         console.log("Device or RecvTransport not initialized");
         return;
      }

      const consumerKey = `${peerId}-${producerId}`;
      if (consumers.has(consumerKey)) {
         console.log("Consumer already exists:", consumerKey);
         return;
      }

      socket.emit(
         "consume",
         {
            transportId: recvTransport.id,
            producerId,
            roomId,
            peerId: socket.id,
            rtpCapabilities: device.rtpCapabilities,
         },
         async (response) => {
            if (response.error) {
               console.error("Error consuming:", response.error);
               return;
            }

            const { consumerData } = response;

            const consumer = await recvTransport.consume({
               id: consumerData.id,
               producerId: consumerData.producerId,
               kind: consumerData.kind,
               rtpParameters: consumerData.rtpParameters,
            });

            await consumer.resume();

            setConsumers((prev) => {
               const newConsumers = new Map(prev);
               newConsumers.set(consumerKey, { consumer, peerId, producerId, kind });
               return newConsumers;
            });

            const remoteStream = new MediaStream();
            remoteStream.addTrack(consumer.track);

            debugMediaStream(remoteStream, `Remote Stream ${consumerKey}`);
            console.log(">> consume remoteStream", remoteStream);

            if (consumer.kind === "video") {
               debugVideoTrack(consumer.track);

               const videoElement = document.createElement("video");

               // FIX: Thêm attributes quan trọng cho video element
               videoElement.setAttribute("playsinline", "");
               videoElement.setAttribute("autoplay", "");
               videoElement.setAttribute("muted", "");
               videoElement.style.width = "200px";
               videoElement.style.height = "auto";
               videoElement.style.margin = "5px";
               videoElement.style.border = "1px solid blue";
               videoElement.style.background = "#000000";
               videoElement.style.objectFit = "cover"; // FIX: Đảm bảo video fill element
               videoElement.id = `video-${consumerKey}`;

               // FIX: Event handlers để debug và fix video issues
               let metadataLoaded = false;

               videoElement.addEventListener("loadstart", () => {
                  console.log("✅ Video loadstart:", consumerKey);
               });

               videoElement.addEventListener("loadedmetadata", () => {
                  console.log("✅ Video metadata loaded:", consumerKey);
                  console.log(
                     "Video dimensions:",
                     videoElement.videoWidth,
                     "x",
                     videoElement.videoHeight
                  );
                  metadataLoaded = true;

                  // FIX: Force play sau khi metadata loaded
                  videoElement.play().catch((err) => {
                     console.error("❌ Video play after metadata failed:", err);
                  });
               });

               videoElement.addEventListener("loadeddata", () => {
                  console.log("✅ Video data loaded:", consumerKey);
               });

               videoElement.addEventListener("canplay", () => {
                  console.log("✅ Video can play:", consumerKey);
                  if (!metadataLoaded) {
                     videoElement.play().catch((err) => {
                        console.error("❌ Video play on canplay failed:", err);
                     });
                  }
               });

               videoElement.addEventListener("playing", () => {
                  console.log("✅ Video playing:", consumerKey);
               });

               videoElement.addEventListener("pause", () => {
                  console.log("⚠️ Video paused:", consumerKey);
               });

               videoElement.addEventListener("stalled", () => {
                  console.log("⚠️ Video stalled:", consumerKey);
               });

               videoElement.addEventListener("waiting", () => {
                  console.log("⚠️ Video waiting:", consumerKey);
               });

               videoElement.addEventListener("error", (e) => {
                  console.error("❌ Video error:", consumerKey, e);
                  const error = videoElement.error;
                  if (error) {
                     console.error("Video error details:", {
                        code: error.code,
                        message: error.message,
                        MEDIA_ERR_ABORTED: error.MEDIA_ERR_ABORTED,
                        MEDIA_ERR_NETWORK: error.MEDIA_ERR_NETWORK,
                        MEDIA_ERR_DECODE: error.MEDIA_ERR_DECODE,
                        MEDIA_ERR_SRC_NOT_SUPPORTED: error.MEDIA_ERR_SRC_NOT_SUPPORTED,
                     });
                  }
               });

               // FIX: Set srcObject và thêm vào DOM
               videoElement.srcObject = remoteStream;
               document.getElementById("remote-media").appendChild(videoElement);

               // FIX: Force reload nếu cần thiết
               setTimeout(() => {
                  if (videoElement.readyState === 0 && videoElement.networkState === 2) {
                     console.log("🔄 Forcing video reload for:", consumerKey);
                     videoElement.load();
                  }
                  debugVideoElement(videoElement, consumerKey);
               }, 2000);

               // FIX: Thêm fallback để refresh video track nếu bị stuck
               setTimeout(() => {
                  if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
                     console.log("🔄 Video dimensions still 0, refreshing track:", consumerKey);

                     // Tạo stream mới và gán lại
                     const newStream = new MediaStream();
                     newStream.addTrack(
                        consumer.track.clone ? consumer.track.clone() : consumer.track
                     );
                     videoElement.srcObject = newStream;
                     videoElement.load();
                  }
               }, 5000);

               console.log("✅ Added video element for:", consumerKey);
            } else if (consumer.kind === "audio") {
               const audioElement = document.createElement("audio");
               audioElement.srcObject = remoteStream;
               audioElement.autoplay = true;
               audioElement.controls = true;
               audioElement.id = `audio-${consumerKey}`;
               audioElement.style.margin = "5px";
               document.getElementById("remote-media").appendChild(audioElement);

               try {
                  await audioElement.play();
                  console.log("✅ Audio playing for:", consumerKey);
               } catch (err) {
                  console.error("❌ Audio playback failed:", err);
               }
            }
         }
      );
   };

   // Debug functions for buttons
   const playAllRemoteVideos = () => {
      const videos = document.querySelectorAll("#remote-media video");
      videos.forEach(async (video, index) => {
         try {
            console.log(`🔄 Trying to play video ${index}:`, {
               readyState: video.readyState,
               networkState: video.networkState,
               paused: video.paused,
               dimensions: `${video.videoWidth}x${video.videoHeight}`,
            });

            if (video.readyState === 0) {
               video.load(); // Force reload
            }

            await video.play();
            console.log(`✅ Video ${index} played successfully`);
         } catch (err) {
            console.error(`❌ Video ${index} play failed:`, err);
         }
      });
   };

   const debugRemoteMedia = () => {
      const remoteMediaDiv = document.getElementById("remote-media");
      console.log("Remote media children:", remoteMediaDiv.children.length);
      Array.from(remoteMediaDiv.children).forEach((child, index) => {
         console.log(`Child ${index}:`, child.tagName, child.id);
         if (child.tagName === "VIDEO") {
            debugVideoElement(child, `Remote Video ${index}`);
         }
      });
   };

   const debugConsumers = () => {
      console.log("Current consumers:", Array.from(consumers.keys()));
      consumers.forEach((value, key) => {
         console.log(`Consumer ${key}:`, {
            kind: value.kind,
            peerId: value.peerId,
            producerId: value.producerId,
            track: value.consumer.track,
            trackSettings: value.consumer.track.getSettings
               ? value.consumer.track.getSettings()
               : "N/A",
         });
      });
   };

   const forceRefreshVideos = () => {
      const videos = document.querySelectorAll("#remote-media video");
      videos.forEach((video, index) => {
         console.log(`🔄 Force refreshing video ${index}`);
         const currentSrc = video.srcObject;
         video.srcObject = null;
         setTimeout(() => {
            video.srcObject = currentSrc;
            video.load();
         }, 100);
      });
   };

   return (
      <div>
         <h1>Mediasoup Demo</h1>
         <h2>My Id: {socket ? socket.id : "Not connected"}</h2>
         <h2>Room: {roomId ? roomId : "-"}</h2>
         {!joined ? (
            <div>
               <input
                  type="text"
                  placeholder="Room ID"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
               />
               <button onClick={joinRoom}>Join Room</button>
            </div>
         ) : (
            <div>
               <button onClick={leaveRoom}>Leave Room</button>
               <button onClick={localStream ? stopCamera : startCamera}>
                  {localStream ? "Stop Camera" : "Start Camera"}
               </button>
               <button onClick={screenProducer ? stopScreenShare : startScreenShare}>
                  {screenProducer ? "Stop Screen Share" : "Start Screen Share"}
               </button>
            </div>
         )}

         {/* Enhanced Debug Controls */}
         {joined && (
            <div style={{ margin: "20px 0", padding: "10px", border: "1px solid #ccc" }}>
               <h3>Debug Controls</h3>
               <button onClick={playAllRemoteVideos} style={{ margin: "5px" }}>
                  🎬 Play All Remote Videos
               </button>
               <button onClick={debugRemoteMedia} style={{ margin: "5px" }}>
                  🔍 Debug Remote Media
               </button>
               <button onClick={debugConsumers} style={{ margin: "5px" }}>
                  📊 Debug Consumers
               </button>
               <button onClick={forceRefreshVideos} style={{ margin: "5px" }}>
                  🔄 Force Refresh Videos
               </button>
            </div>
         )}

         <div>
            <h2>Local Video</h2>
            <video ref={localVideoRef} autoPlay playsInline muted width="400"></video>
         </div>
         <div>
            <h2>Peers in Room</h2>
            <ul>
               {peers.map((peerId) => (
                  <li key={peerId}>{peerId}</li>
               ))}
            </ul>
         </div>
         <div>
            <h2>Remote Media</h2>
            <div
               id="remote-media"
               style={{
                  border: "2px solid red",
                  minHeight: "200px",
                  background: "#f0f0f0",
                  padding: "10px",
               }}
            ></div>
         </div>

         {/* Enhanced CSS */}
         <style jsx>{`
            #remote-media video {
               border: 1px solid blue !important;
               display: block !important;
               visibility: visible !important;
               opacity: 1 !important;
               max-width: 100%;
               height: auto;
               background: black;
               object-fit: cover;
            }

            video {
               -webkit-transform: translateZ(0);
               -moz-transform: translateZ(0);
               -ms-transform: translateZ(0);
               -o-transform: translateZ(0);
               transform: translateZ(0);
            }
         `}</style>
      </div>
   );
}

export default App;
