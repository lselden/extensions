// Name: MIDI
// ID: midi
// Description: An extension that retrieves input from MIDI devices.
// By: -MasterMath- <https://scratch.mit.edu/users/-MasterMath-/>
// License: MPL-2.0

(function (Scratch) {
  "use strict";

  if (!Scratch.extensions.unsandboxed) {
    alert("This MIDI extension must run unsandboxed!");
    throw new Error("This MIDI extension must run unsandboxed!");
  }

  
  //#region midi message parsing/formatting

  /** 
   * This section includes logic to map raw data coming from the 'midimessage'
   * event into a friendly object representation of the event
   * 
   * 
   * // definition for the parsed midi event
   * @typedef {keyof typeof eventMapping} EventType
   * @typedef {object} MidiEvent
   * @property {EventType} type
   * @property {number} [value1]
   * @property {number} [value2]
   * @property {number} [channel]
   * @property {number} [device]
   * @property {number} [time]
   * @property {number} [pitch]
   * @property {number} [velocity]
   * @property {number} [cc]
   * @property {number} [value]
   */

  /**
   * MIDI commands with code, name, and parameters
   * From: https://ccrma.stanford.edu/~craig/articles/linuxmidi/misc/essenmidi.html
   * https://www.midi.org/specifications/item/table-1-summary-of-midi-message
   *
   * adapted from https://github.com/fheyen/musicvis-lib/blob/905edbdc8280e8ca76a329ffc83a160f3cda674a/src/fileFormats/Midi.js#L41
   * 
   * each key (the "EventType" relates to a raw midi "command". The "shorthand" could
   * be used to format midi events to string (future). param1 and param2 determine what property of the object the value1 + value2 bytes mean (i.e. noteOn gets pitch + velocity, cc gets cc# and value)
   */
  const eventMapping = {
    noteOn: { command: 0x90, shorthand: 'note', description: 'Note-on', param1: 'pitch', param2: 'velocity' },
    noteOff: { command: 0x80, shorthand: 'off', description: 'Note-off', param1: 'pitch', param2: 'velocity' },
    cc: { command: 0xB0, shorthand: 'cc', description: 'Continuous controller', param1: 'cc', param2: 'value' },
    aftertouch: { command: 0xA0, shorthand: 'touch', description: 'Aftertouch', param1: 'pitch', param2: 'value' },
    programChange: { command: 0xC0, shorthand: 'program', description: 'Patch change', param1: 'value' },
    pitchBend: { command: 0xE0, shorthand: 'bend', description: 'Pitch bend', highResParam: 'value' },
    channelPressure: { command: 0xD0, shorthand: 'pressure', description: 'Channel Pressure', param1: 'value' },
    songPosition: { command: 0xF2, shorthand: 'songpos', description: 'Song Position Pointer (Sys Common)', highResParam: 'value' },
    songSelect: { command: 0xF3, shorthand: 'songsel', description: 'Song Select (Sys Common)', param1: 'value' },
    clock: { command: 0xF8, shorthand: 'clock', description: 'Timing Clock (Sys Realtime)' },
    start: { command: 0xFA, shorthand: 'start', description: 'Start (Sys Realtime)' },
    continue: { command: 0xFB, shorthand: 'continue', description: 'Continue (Sys Realtime)' },
    stop: { command: 0xFC, shorthand: 'stop', description: 'Stop (Sys Realtime)' },
    activeSensing: { command: 0xFE, shorthand: 'ping', description: 'Active Sensing (Sys Realtime)' },
    reset: { command: 0xFF, shorthand: 'reset', description: 'System Reset (Sys Realtime)' },
  };

  // parse out full spec into quick lookups
  /** @type {Map<number, EventType>} */
  // @ts-ignore
  const commandLookup = new Map(Object.entries(eventMapping).map(([key, { command }]) => [command, key]));

  /** convert 7-bit byte pair into 0-16384 range
   * adapted from https://github.com/djipco/webmidi/blob/master/src/Utilities.js#L444
   */
  function msbLsbToValue(value1, value2) {
    return (value2 << 7) + value1;
  }

  /**
   * Parse raw midi bytes into the actual event details
   * @param {Uint8Array} data 
   * @returns {MidiEvent | null}
   */
  function rawMessageToMidi(data) {
    const [commandAndChannel, value1, value2] = data;

    const channel = commandAndChannel % 16;
    const command = commandAndChannel - channel;
    const type = commandLookup.get(command);

    if (!type) {
      console.debug('unknown command type', command);
      return null;
    }

    /** @type {MidiEvent} */
    const event = {
      type,
      channel,
      ...(value1 != undefined) && { value1 },
      ...(value2 != undefined) && { value2 }
    };

    // look up the event type and parse the value1 + value2 bytes accordingly
    const spec = eventMapping[type];

    if (spec?.param1 && event.value1 != undefined) {
      event[spec.param1] ??= event.value1;
    }
    if (spec?.param2 && event.value2 != undefined) {
      event[spec.param2] ??= event.value2;
    }
    if (spec.highResParam) {
      const { value } = msbLsbToValue(value1, value2);
      event[spec.highResParam] = value;
    }
    return event;
  }

  //#endregion

  
  class MidiBackend extends EventTarget {
    status = 'pending';

    /** @type {MIDIAccess | undefined} */
    midiAccess = undefined;

    /** @type {MIDIInput[]} */
    inputs = [];

    /** @type {MIDIOutput[]} */
    outputs = []

    /** @type {Promise<boolean> | undefined} */
    _init = undefined;
    async initialize({ force = false, timeoutMilliseconds = 30_0000 } = {}) {
      // exit early if no midi available
      if (!navigator.requestMIDIAccess) {
        return false;
      }
      // do not re-attempt if already initializing
      if (this._init && !force) {
        return this._init;
      }

      this._init = (async () => {
        this.status = 'initializing';

        // add timeout in case inital call never triggers request
        let timer;
        /** @type {Promise<never>} */
        const whenTimeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new DOMException('Timeout waiting for midi access')), timeoutMilliseconds);
        });
        try {
          this.midiAccess = await Promise.race([
            navigator.requestMIDIAccess(),
            whenTimeout
          ]);
          clearTimeout(timer);
          this.refreshDevices();
          this.midiAccess.addEventListener('statechange', this.refreshDevices);
          this.status = 'connected';
          return true;
        } catch (error) {
          this.status = 'error';
          return false;
        } finally {
          // in case anything needs to be notified when midi available has changed
          this._emit('statechange');
        }
      })();
      return this._init;
    }

    /**
     * go through all midi inputs, and see if we already know about it
     * TIP! If you use arrow functions on class methos then 'this' is automatically bound correctly, even if using as event listener
     */
    refreshDevices = () => {
      for (const input of this.midiAccess.inputs.values()) {
        if (!this.inputs.some(d => d.id === input.id)) {
          input.addEventListener('midimessage', this._onInputEvent);
          input.addEventListener('statechange', this._onDeviceStateChange);
          this.inputs.push(input);
        }
      }

      for (const output of this.midiAccess.outputs.values()) {
        if (!this.outputs.some(d => d.id === output.id)) {
            this.outputs.push(output);
        }
      }
    }
    get isMidiAvailable() {
      return !!navigator.requestMIDIAccess && this.status !== 'error';
    }
    get isConnected() {
      return this.status === 'connected';
    }
    /**
     * Fired when device connected/disconnected.  
     * @param {MIDIConnectionEvent} event
     */
    _onDeviceStateChange = (event) => {
      const { port } = event;
      if (!port) return;
      const { type, id, name } = port;
      const deviceList = type === 'input' ? this.inputs : this.outputs;
      const index = deviceList.findIndex(dev => dev.id === id);
      // not found - new device?
      if (index === -1) {
        this.refreshDevices();
        return;
      }

      // if anything needs to be notified of new devices, or change in device state
      this._emit('statechange', { index, id, name, type, state: port.state });
    }
    /**
     * Where the actual midi message comes in and is parsed
     * The re-emitted as an object
     * @param {MIDIMessageEvent} event 
     */
    _onInputEvent = (event) => {
      const {
        data,
        timeStamp
      } = event;
      /** @type {MIDIInput} */
      // @ts-ignore
      const device = event.target;

      if (!data) return;

      const deviceIndex = this.inputs.indexOf(device);
      const midiEvent = rawMessageToMidi(data);
      if (!midiEvent) {
        console.warn('Unable to parse message', data);
        // TODO handle?...this should only happen with Sysex/MMC messages, and
        // those likely need {sysex: true} passed in requestMidiAccess
        this._emit('midi:unhandled', event);
      } else {
        // REVIEW - using incoming timestamp which is likely just based off of when page loaded, but no particular standard. Could also just use Date.now()
        midiEvent.time = timeStamp;
        // REVIEW - This is storing a reference to midi device by array index,
        // rather than ID. MidiBackend tries to maintain device index even when devices
        // disconnected, but may make sense to use device.id instead.
        if (deviceIndex !== -1) { midiEvent.device = deviceIndex; }

        // actually emit the parsed event
        this._emit('midi', midiEvent);
      }
    }
    /**
     * dispatch an event
     * @param {string} name 
     * @param {Record<string, any>} [data] 
     */
    _emit(name, data = {}) {
      const event = new CustomEvent(name, { detail: data });
      this.dispatchEvent(event);
    }
  }

  /** @type {string[]} */
  let midiInputDevices = [];
  /** @type {Array<[id: string, name: string]>} */
  let midiDeviceInfo = [];

  const midiBackend = new MidiBackend();
  // emits statechange when request succeeded/failed, and on device connection events
  midiBackend.addEventListener('statechange', (event) => {
    switch (midiBackend.status) {
      case 'connected':
        // do something on success
        break;
      case 'error':
        // do something on error
        break;
    }
    // regenerate arrays on each update, rather than mutating
    midiInputDevices = midiBackend.inputs.map(port => `[id: "${port.id}"` + ` name: "${port.name}"]`);
    midiDeviceInfo = midiBackend.inputs.map(port => [port.id, port.name]);
  });

  midiBackend.addEventListener('midi', domEvent => {
    /** @type {MidiEvent} */
    // @ts-ignore
    const midiEvent = domEvent.detail;
    onMIDIMessage(midiEvent);
  });

  // trigger init
  // QUESTION - should requestMidiAccess get called immediately on extension load?
  // or should it get called in a vm.runtime.once('BEFORE_EXECUTE') call? Or some
  // other method to defer the request until an opportune time?
  midiBackend.initialize();

  
  /**
   * MIDI event is parsed by MidiBackend above
   * @param {MidiEvent} event 
   */
  function onMIDIMessage(event) {
  }


  let notesOn = [];
  let noteVelocities = [];
  let lastNotePressed = 0;
  let lastNoteReleased = 0;


      function onMIDIMessage(event) {
        const [status, note, velocity] = event.data;
        const command = status & 0xf0;
        if (command === 0x90 && velocity > 0) {
          notesOn.push(note);
          noteVelocities.push([note, velocity]);
          lastNotePressed = note;
          Scratch.vm.runtime.startHats("midi_whenAnyNote", {
            pressedReleased: "pressed",
          });
          Scratch.vm.runtime.startHats("midi_whenNote", {
            note: note,
            pressedReleased: "pressed",
          });
        } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
          lastNoteReleased = note;
          notesOn.splice(notesOn.indexOf(note), 1);
          noteVelocities.splice(
            noteVelocities.findIndex((subArray) => subArray[0] === note),
            1
          );
          Scratch.vm.runtime.startHats("midi_whenAnyNote", {
            pressedReleased: "released",
          });
          Scratch.vm.runtime.startHats("midi_whenNote", {
            note: note,
            pressedReleased: "released",
          });
        } else {
          console.log(
            `Other MIDI Message: Status=${status}, Note=${note}, Velocity=${velocity}, Timestamp ${event.timeStamp}`
          );
        }
      }

  class MIDI {
    getInfo() {
      return {
        id: "midi",
        name: "MIDI",
        blocks: [
          {
            opcode: "MIDIinputDevices",
            blockType: Scratch.BlockType.REPORTER,
            text: "connected MIDI input devices",
            disableMonitor: true,
          },
          {
            opcode: "midiDeviceInfo",
            blockType: Scratch.BlockType.REPORTER,
            text: "[info] of MIDI device [number]",
            arguments: {
              info: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "name",
                menu: "infoMenu",
              },
              number: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 0,
              },
            },
          },
          "---",
          {
            opcode: "whenAnyNote",
            blockType: Scratch.BlockType.EVENT,
            text: "when any note [pressedReleased]",
            isEdgeActivated: false,
            shouldRestartExistingThreads: true,
            arguments: {
              pressedReleased: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "pressed",
                menu: "pressedReleased",
              },
            },
          },
          {
            opcode: "whenNote",
            blockType: Scratch.BlockType.EVENT,
            text: "when note [note] [pressedReleased]",
            isEdgeActivated: false,
            shouldRestartExistingThreads: true,
            arguments: {
              note: {
                type: Scratch.ArgumentType.NOTE,
                defaultValue: 60,
              },
              pressedReleased: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "pressed",
                menu: "pressedReleased",
              },
            },
          },
          {
            opcode: "noteOn",
            blockType: Scratch.BlockType.BOOLEAN,
            text: "is note [note] on?",
            arguments: {
              note: {
                type: Scratch.ArgumentType.NOTE,
                defaultValue: 60,
              },
            },
          },
          {
            opcode: "noteVelocity",
            blockType: Scratch.BlockType.REPORTER,
            text: "velocity of note [note]",
            arguments: {
              note: {
                type: Scratch.ArgumentType.NOTE,
                defaultValue: 60,
              },
            },
          },
          {
            opcode: "activeNotes",
            blockType: Scratch.BlockType.REPORTER,
            text: "all active notes",
            disableMonitor: true,
          },
          {
            opcode: "lastNote",
            blockType: Scratch.BlockType.REPORTER,
            text: "last note [pressedReleased]",
            disableMonitor: true,
            arguments: {
              pressedReleased: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "pressed",
                menu: "pressedReleased",
              },
            },
          },
        ],
        menus: {
          infoMenu: {
            acceptReporters: false,
            items: ["name", "id"],
          },
          pressedReleased: {
            acceptReporters: false,
            items: ["pressed", "released"],
          },
        },
      };
    }

    MIDIinputDevices() {
      return midiInputDevices;
    }

    midiDeviceInfo(args) {
      if (midiInputDevices[args.number] != null) {
        return midiDeviceInfo[args.number][args.info == "id" ? 0 : 1];
      } else {
        return;
      }
    }

    noteOn(args) {
      return notesOn.includes(Number(args.note));
    }

    noteVelocity(args) {
      if (
        notesOn.includes(args.note) &&
        noteVelocities.find((subArray) => subArray[0] === args.note)[1] !==
          undefined
      ) {
        return noteVelocities.find((subArray) => subArray[0] === args.note)[1];
      }
    }

    activeNotes() {
      return notesOn;
    }

    lastNote({ pressedReleased }) {
      if (pressedReleased == "pressed") {
        return lastNotePressed;
      } else {
        return lastNoteReleased;
      }
    }
  }

  Scratch.extensions.register(new MIDI());
})(Scratch);
