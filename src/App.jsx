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

      const stream = await navigator.mediaDevices.getUserMedia({
         video: true,
      });
      setLocalStream(stream);

      if (localVideoRef.current) {
         localVideoRef.current.srcObject = stream;
      }

      const videoTrack = stream.getVideoTracks()[0];
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
      if (audioProducer) {
         audioProducer.close();
         setAudioProducer(null);
      }
   };

   const startScreenShare = async () => {
      if (!sendTransport) return;

      const stream = await navigator.mediaDevices.getDisplayMedia({
         video: true,
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
               videoElement.srcObject = remoteStream;
               videoElement.autoplay = true;
               videoElement.playsInline = true;
               videoElement.muted = true; // Fix autoplay policy issue
               videoElement.width = 200;
               videoElement.id = `video-${consumerKey}`;
               videoElement.style.margin = "5px";
               videoElement.style.border = "1px solid blue"; // Debug CSS
               videoElement.style.background = "black"; // Debug CSS

               // Add extensive event listeners for debugging
               videoElement.addEventListener("loadstart", () =>
                  console.log("Video loadstart:", consumerKey)
               );
               videoElement.addEventListener("loadedmetadata", () =>
                  console.log("Video metadata loaded:", consumerKey)
               );
               videoElement.addEventListener("loadeddata", () =>
                  console.log("Video loadeddata:", consumerKey)
               );
               videoElement.addEventListener("canplay", () =>
                  console.log("Video canplay:", consumerKey)
               );
               videoElement.addEventListener("canplaythrough", () =>
                  console.log("Video canplaythrough:", consumerKey)
               );
               videoElement.addEventListener("playing", () =>
                  console.log("Video playing:", consumerKey)
               );
               videoElement.addEventListener("pause", () =>
                  console.log("Video paused:", consumerKey)
               );
               videoElement.addEventListener("ended", () =>
                  console.log("Video ended:", consumerKey)
               );
               videoElement.addEventListener("error", (e) => {
                  console.error("Video element error:", e);
                  console.error("Video error details:", {
                     error: videoElement.error,
                     networkState: videoElement.networkState,
                     readyState: videoElement.readyState,
                  });
               });

               videoElement.onerror = (e) => {
                  console.error("Video element error:", e);
               };

               videoElement.onloadedmetadata = () => {
                  console.log("Video metadata loaded for:", consumerKey);
               };

               document.getElementById("remote-media").appendChild(videoElement);

               // Debug after adding to DOM
               setTimeout(() => {
                  debugVideoElement(videoElement, consumerKey);
               }, 1000);

               // Try manual play if autoplay fails
               videoElement.play().catch((err) => {
                  console.error("Auto video play failed:", err);
                  console.log("You may need to click 'Play All Remote Videos' button");
               });

               console.log("Added video element for:", consumerKey);
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
                  console.log("Audio playing for:", consumerKey);
               } catch (err) {
                  console.error("Audio playback failed:", err);
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
            await video.play();
            console.log(`Video ${index} played successfully`);
         } catch (err) {
            console.error(`Video ${index} play failed:`, err);
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
         });
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

         {/* Debug Controls */}
         {joined && (
            <div style={{ margin: "20px 0", padding: "10px", border: "1px solid #ccc" }}>
               <h3>Debug Controls</h3>
               <button onClick={playAllRemoteVideos} style={{ margin: "5px" }}>
                  Play All Remote Videos
               </button>
               <button onClick={debugRemoteMedia} style={{ margin: "5px" }}>
                  Debug Remote Media
               </button>
               <button onClick={debugConsumers} style={{ margin: "5px" }}>
                  Debug Consumers
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
                  border: "2px solid red", // Debug CSS
                  minHeight: "200px",
                  background: "#f0f0f0",
                  padding: "10px",
               }}
            ></div>
         </div>

         {/* Add CSS for debugging */}
         <style jsx>{`
            #remote-media video {
               border: 1px solid blue !important;
               display: block !important;
               visibility: visible !important;
               opacity: 1 !important;
               max-width: 100%;
               height: auto;
               background: black;
            }
         `}</style>
      </div>
   );
}

export default App;
