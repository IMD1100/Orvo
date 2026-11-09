#include "vendor/signalsmith-stretch/signalsmith-stretch.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_dsp/juce_dsp.h>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <vector>
#if JUCE_WINDOWS
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

using namespace juce;
namespace {
constexpr int blockSize = 512;
using Json = var;
[[noreturn]] void fail(const String &s) {
  throw std::runtime_error(s.toStdString());
}
Json object() { return Json(new DynamicObject()); }
void put(Json &o, const Identifier &key, const Json &value) {
  o.getDynamicObject()->setProperty(key, value);
}
Json copy(const Json &j) {
  return j.isObject() || j.isArray() ? JSON::parse(JSON::toString(j, true)) : j;
}
Json array(const std::vector<double> &v) {
  Array<var> a;
  for (auto x : v)
    a.add(x);
  return a;
}
Json pair(double a, double b) { return Array<var>{a, b}; }
class ProtocolOutput {
  FILE *pipe = nullptr;

public:
  ProtocolOutput() {
    // Reserve the protocol pipe before loading JUCE/plugins; their stdout logs
    // go to stderr.
#if JUCE_WINDOWS
    int descriptor = _dup(_fileno(stdout));
    if (descriptor >= 0)
      pipe = _fdopen(descriptor, "wb");
    _dup2(_fileno(stderr), _fileno(stdout));
    SetStdHandle(STD_OUTPUT_HANDLE, GetStdHandle(STD_ERROR_HANDLE));
#else
    int descriptor = dup(fileno(stdout));
    if (descriptor >= 0)
      pipe = fdopen(descriptor, "w");
    dup2(fileno(stderr), fileno(stdout));
#endif
    if (!pipe)
      fail("Cannot reserve response pipe");
  }
  ~ProtocolOutput() {
    if (pipe)
      std::fclose(pipe);
  }
  void write(const Json &response) {
    auto text = JSON::toString(response, true).toStdString() + "\n";
    if (std::fwrite(text.data(), 1, text.size(), pipe) != text.size() ||
        std::fflush(pipe) != 0)
      fail("Cannot write response pipe");
  }
};
void require(bool b, const String &s) {
  if (!b)
    fail(s);
}
bool has(const Json &j, const Identifier &key) { return j.hasProperty(key); }
double number(const Json &j, const Identifier &key, double lo, double hi) {
  auto v = j[key];
  require((v.isDouble() || v.isInt() || v.isInt64()) &&
              std::isfinite((double)v),
          key.toString() + " must be finite numeric");
  double x = v;
  require(x >= lo && x <= hi, key.toString() + " out of range");
  return x;
}
String string(const Json &j, const Identifier &key) {
  require(j[key].isString(), key.toString() + " must be a string");
  return j[key].toString();
}
bool boolean(const Json &j, const Identifier &key, bool fallback = false) {
  if (!has(j, key))
    return fallback;
  require(j[key].isBool(), key.toString() + " must be boolean");
  return (bool)j[key];
}
bool validId(const String &id) {
  if (id.isEmpty() || id.length() > 64)
    return false;
  for (auto c : id)
    if (!(CharacterFunctions::isLetterOrDigit(c) && c < 128) && c != '_' &&
        c != '-')
      return false;
  return true;
}
float gain(double db) { return Decibels::decibelsToGain((float)db); }
double db(float value) {
  return std::max(-100.0, (double)Decibels::gainToDecibels(value, -100.0f));
}
using Ranges = std::map<String, std::pair<double, double>>;
const std::map<String, Ranges> &catalog() {
  static const std::map<String, Ranges> result = {
      {"gain", {{"gain_db", {-20, 20}}}},
      {"panner", {{"pan", {-1, 1}}}},
      {"stereo_widener", {{"width", {0, 1.5}}}},
      {"distortion", {{"drive_db", {0, 20}}}},
      {"delay",
       {{"delay_seconds", {0, .7}},
        {"feedback", {0, .6}},
        {"mix_ratio", {0, 1}}}},
      {"reverb",
       {{"room_size", {0, .9}},
        {"damping", {0, .9}},
        {"width", {0, .9}},
        {"mix_ratio", {0, 1}}}},
      {"compressor",
       {{"threshold_db", {-40, -5}},
        {"ratio", {1, 20}},
        {"attack_ms", {0, 500}},
        {"release_ms", {0, 1000}}}},
      {"limiter", {{"threshold_db", {-20, -1}}, {"release_ms", {0, 1000}}}},
      {"noise_gate",
       {{"threshold_db", {-100, 0}},
        {"ratio", {1, 20}},
        {"attack_ms", {.1, 100}},
        {"release_ms", {1, 2000}}}},
      {"highpass", {{"cutoff_frequency_hz", {20, 20000}}}},
      {"lowpass", {{"cutoff_frequency_hz", {20, 20000}}}},
      {"chorus",
       {{"rate_hz", {.01, 20}},
        {"depth", {0, 1}},
        {"centre_delay_ms", {1, 30}},
        {"feedback", {-.95, .95}},
        {"mix", {0, 1}}}},
      {"phaser",
       {{"rate_hz", {.01, 20}},
        {"depth", {0, 1}},
        {"centre_frequency_hz", {20, 20000}},
        {"feedback", {-.95, .95}},
        {"mix", {0, 1}}}},
      {"pitch_shift", {{"semitones", {-24, 24}}}},
      {"equalizer",
       {{"low_gain_db", {-20, 20}},
        {"low_cutoff_freq", {20, 400}},
        {"low_q_factor", {.1, 6}},
        {"mid_gain_db", {-20, 20}},
        {"mid_cutoff_freq", {250, 6000}},
        {"mid_q_factor", {.1, 6}},
        {"high_gain_db", {-20, 20}},
        {"high_cutoff_freq", {4000, 20000}},
        {"high_q_factor", {.1, 6}}}}};
  return result;
}
Json emptyGraph() {
  return JSON::parse(
      R"({"schema_version":3,"chain":[],"routing":{"mixers":[],"links":[{"source":"@input","target":"@output","gain_db":0}],"positions":{}}})");
}
Json newProject() {
  auto p = JSON::parse(
      R"({"schemaVersion":1,"name":"Untitled","sampleRate":44100,"tracks":[],"master":{"gainDb":0,"pan":0,"solo":false,"muted":false,"fxEnabled":true},"loop":{"start":0,"end":0,"enabled":false}})");
  auto m = p["master"];
  put(m, "graph", emptyGraph());
  return p;
}
Json newTrack(const String &label) {
  auto t = JSON::parse(
      R"({"gainDb":0,"pan":0,"muted":false,"solo":false,"fxEnabled":true,"source":null})");
  put(t, "id", "track_" + Uuid().toString().removeCharacters("-"));
  put(t, "label", label);
  put(t, "graph", emptyGraph());
  put(t, "clips", Array<var>{});
  return t;
}

// Every built-in is a stateful JUCE DSP processor, or a small stereo DSP
// operation. This graph uses preallocated buffers and an explicit topological
// schedule.
struct Effect {
  String kind;
  Json parameters;
  bool enabled;
  double rate = 44100;
  dsp::Compressor<float> compressor;
  dsp::NoiseGate<float> gate;
  dsp::Chorus<float> chorus;
  dsp::Phaser<float> phaser;
  Reverb reverb;
  std::array<std::array<dsp::IIR::Filter<float>, 3>, 2> filters;
  AudioBuffer<float> delay;
  int delayWrite = 0, delaySamples = 1;
  float limiterGain = 1;
  std::unique_ptr<AudioPluginInstance> plugin;
  std::unique_ptr<signalsmith::stretch::SignalsmithStretch<float>> pitch;
  AudioBuffer<float> pitchOutput;

  Effect(const Json &node, AudioPluginFormatManager &formats, double sr)
      : kind(string(node, "effect")), parameters(node["parameters"]),
        enabled(boolean(node, "enabled", true)) {
    require(parameters.isObject(), "Effect parameters must be an object");
    if (kind == "plugin") {
      auto path = string(node, "pluginPath");
      require(File::isAbsolutePath(path) && File(path).exists(),
              "Plugin path does not exist");
      OwnedArray<PluginDescription> descriptions;
      for (int i = 0; i < formats.getNumFormats(); ++i)
        if (formats.getFormat(i)->fileMightContainThisPluginType(path))
          formats.getFormat(i)->findAllTypesForFile(descriptions, path);
      require(!descriptions.isEmpty(),
              "No supported VST3 plugin found at " + path);
      // Multi-plugin bundles must select a concrete plugin identifier.
      auto wanted = node["pluginIdentifier"].toString();
      PluginDescription *selected = nullptr;
      for (auto *d : descriptions)
        if (wanted.isEmpty() || d->createIdentifierString() == wanted) {
          selected = d;
          break;
        }
      require(selected != nullptr &&
                  (descriptions.size() == 1 || wanted.isNotEmpty()),
              "Ambiguous plugin bundle; supply pluginIdentifier");
      String error;
      plugin = formats.createPluginInstance(*selected, sr, blockSize, error);
      require(plugin != nullptr, "Plugin load failed: " + error);
      AudioProcessor::BusesLayout layout;
      layout.inputBuses.add(AudioChannelSet::stereo());
      layout.outputBuses.add(AudioChannelSet::stereo());
      require(plugin->setBusesLayout(layout),
              "Plugin must support a stereo input/output layout");
      for (const auto &entry : parameters.getDynamicObject()->getProperties()) {
        auto key = entry.name.toString();
        require(key.containsOnly("0123456789") && key.isNotEmpty(),
                "Plugin parameters use zero-based parameter indices");
        int index = key.getIntValue();
        require(index >= 0 && index < plugin->getParameters().size(),
                "Unknown plugin parameter index");
        plugin->getParameters()[index]->setValueNotifyingHost(
            (float)number(parameters, entry.name, 0, 1));
      }
    } else {
      auto found = catalog().find(kind);
      require(found != catalog().end(), "Unsupported effect: " + kind);
      require(parameters.getDynamicObject()->getProperties().size() ==
                  (int)found->second.size(),
              "Effect parameter fields do not match " + kind);
      for (const auto &[key, bounds] : found->second)
        number(parameters, key, bounds.first, bounds.second);
    }
    prepare(sr);
  }
  float p(const char *name) const { return (float)(double)parameters[name]; }
  int latency() const {
    return pitch ? pitch->inputLatency() + pitch->outputLatency() : 0;
  }
  void prepare(double sr) {
    rate = sr;
    if (kind == "pitch_shift") {
      if (enabled && p("semitones") != 0) {
        pitch =
            std::make_unique<signalsmith::stretch::SignalsmithStretch<float>>(
                0);
        pitch->presetDefault(2, (float)sr);
        pitch->setTransposeSemitones(p("semitones"));
        pitchOutput.setSize(2, blockSize);
      }
      reset();
      return;
    }
    dsp::ProcessSpec spec{sr, blockSize, 2};
    compressor.prepare(spec);
    gate.prepare(spec);
    chorus.prepare(spec);
    phaser.prepare(spec);
    reverb.setSampleRate(sr);
    delay.setSize(2, (int)std::ceil(sr * .7) + 2);
    delay.clear();
    delayWrite = 0;
    delaySamples = jlimit(0, delay.getNumSamples() - 1,
                          (int)std::round(p("delay_seconds") * sr));
    limiterGain = 1;
    if (kind == "compressor") {
      compressor.setThreshold(p("threshold_db"));
      compressor.setRatio(p("ratio"));
      compressor.setAttack(p("attack_ms"));
      compressor.setRelease(p("release_ms"));
    }
    if (kind == "noise_gate") {
      gate.setThreshold(p("threshold_db"));
      gate.setRatio(p("ratio"));
      gate.setAttack(p("attack_ms"));
      gate.setRelease(p("release_ms"));
    }
    if (kind == "chorus") {
      chorus.setRate(p("rate_hz"));
      chorus.setDepth(p("depth"));
      chorus.setCentreDelay(p("centre_delay_ms"));
      chorus.setFeedback(p("feedback"));
      chorus.setMix(p("mix"));
    }
    if (kind == "phaser") {
      phaser.setRate(p("rate_hz"));
      phaser.setDepth(p("depth"));
      phaser.setCentreFrequency(
          std::min(p("centre_frequency_hz"), (float)sr * .49f));
      phaser.setFeedback(p("feedback"));
      phaser.setMix(p("mix"));
    }
    if (kind == "reverb") {
      Reverb::Parameters rp;
      rp.roomSize = p("room_size");
      rp.damping = p("damping");
      rp.width = p("width");
      rp.wetLevel = p("mix_ratio");
      rp.dryLevel = 1 - rp.wetLevel;
      reverb.setParameters(rp);
    }
    auto freq = [sr](float f) { return jlimit(1.0f, (float)sr * .49f, f); };
    for (auto &channel : filters) {
      if (kind == "highpass")
        channel[0].coefficients = dsp::IIR::Coefficients<float>::makeHighPass(
            sr, freq(p("cutoff_frequency_hz")));
      if (kind == "lowpass")
        channel[0].coefficients = dsp::IIR::Coefficients<float>::makeLowPass(
            sr, freq(p("cutoff_frequency_hz")));
      if (kind == "equalizer") {
        channel[0].coefficients = dsp::IIR::Coefficients<float>::makeLowShelf(
            sr, freq(p("low_cutoff_freq")), p("low_q_factor"),
            gain(p("low_gain_db")));
        channel[1].coefficients = dsp::IIR::Coefficients<float>::makePeakFilter(
            sr, freq(p("mid_cutoff_freq")), p("mid_q_factor"),
            gain(p("mid_gain_db")));
        channel[2].coefficients = dsp::IIR::Coefficients<float>::makeHighShelf(
            sr, freq(p("high_cutoff_freq")), p("high_q_factor"),
            gain(p("high_gain_db")));
      }
    }
    if (plugin) {
      plugin->releaseResources();
      plugin->setRateAndBufferSizeDetails(sr, blockSize);
      plugin->prepareToPlay(sr, blockSize);
    }
    reset();
  }
  void reset() {
    if (kind == "pitch_shift") {
      if (pitch)
        pitch->reset();
      return;
    }
    compressor.reset();
    gate.reset();
    chorus.reset();
    phaser.reset();
    reverb.reset();
    delay.clear();
    delayWrite = 0;
    limiterGain = 1;
    for (auto &c : filters)
      for (auto &f : c)
        f.reset();
    if (plugin)
      plugin->reset();
  }
  void process(AudioBuffer<float> &b, int n) {
    if (!enabled)
      return;
    if (kind == "pitch_shift") {
      if (pitch) {
        pitch->process(b.getArrayOfReadPointers(), n,
                       pitchOutput.getArrayOfWritePointers(), n);
        for (int c = 0; c < 2; ++c)
          b.copyFrom(c, 0, pitchOutput, c, 0, n);
      }
      return;
    }
    dsp::AudioBlock<float> full(b);
    auto block = full.getSubBlock(0, (size_t)n);
    dsp::ProcessContextReplacing<float> context(block);
    if (plugin) {
      MidiBuffer midi;
      AudioBuffer<float> view(b.getArrayOfWritePointers(), 2, n);
      plugin->processBlock(view, midi);
      return;
    }
    if (kind == "compressor") {
      compressor.process(context);
      return;
    }
    if (kind == "noise_gate") {
      gate.process(context);
      return;
    }
    if (kind == "chorus") {
      chorus.process(context);
      return;
    }
    if (kind == "phaser") {
      phaser.process(context);
      return;
    }
    if (kind == "reverb") {
      reverb.processStereo(b.getWritePointer(0), b.getWritePointer(1), n);
      return;
    }
    if (kind == "gain") {
      b.applyGain(0, n, gain(p("gain_db")));
      return;
    }
    if (kind == "highpass" || kind == "lowpass" || kind == "equalizer") {
      for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i) {
          float x = b.getSample(c, i);
          for (int k = 0; k < (kind == "equalizer" ? 3 : 1); ++k)
            x = filters[(size_t)c][(size_t)k].processSample(x);
          b.setSample(c, i, x);
        }
      return;
    }
    for (int i = 0; i < n; ++i) {
      float l = b.getSample(0, i), r = b.getSample(1, i);
      if (kind == "panner") {
        float pan = p("pan");
        l *= std::sqrt(1 - std::max(0.0f, pan));
        r *= std::sqrt(1 + std::min(0.0f, pan));
      } else if (kind == "stereo_widener") {
        float mid = (l + r) * .5f, side = (l - r) * .5f * p("width");
        l = mid + side;
        r = mid - side;
      } else if (kind == "distortion") {
        float drive = gain(p("drive_db"));
        l = std::tanh(l * drive);
        r = std::tanh(r * drive);
      } else if (kind == "delay") {
        int read = (delayWrite + delay.getNumSamples() - delaySamples) %
                   delay.getNumSamples();
        float dl = delaySamples == 0 ? l : delay.getSample(0, read),
              dr = delaySamples == 0 ? r : delay.getSample(1, read);
        delay.setSample(0, delayWrite, l + dl * p("feedback"));
        delay.setSample(1, delayWrite, r + dr * p("feedback"));
        l = l * (1 - p("mix_ratio")) + dl * p("mix_ratio");
        r = r * (1 - p("mix_ratio")) + dr * p("mix_ratio");
        delayWrite = (delayWrite + 1) % delay.getNumSamples();
      } else if (kind == "limiter") {
        float ceiling = gain(p("threshold_db")),
              peak = std::max(std::abs(l), std::abs(r));
        float target = peak > ceiling ? ceiling / peak : 1.0f;
        float release =
            p("release_ms") <= 0
                ? 0.0f
                : std::exp(-1.0f / ((float)rate * p("release_ms") * .001f));
        limiterGain = target < limiterGain
                          ? target
                          : release * limiterGain + (1 - release) * target;
        l *= limiterGain;
        r *= limiterGain;
      }
      b.setSample(0, i, l);
      b.setSample(1, i, r);
    }
  }
};

struct StereoDelay {
  AudioBuffer<float> ring;
  int cursor = 0;

  void configure(int samples) {
    ring.setSize(2, samples);
    reset();
  }
  void reset() {
    ring.clear();
    cursor = 0;
  }
  void process(AudioBuffer<float> &audio, int n) {
    const int size = ring.getNumSamples();
    if (size == 0)
      return;
    auto *left = audio.getWritePointer(0), *right = audio.getWritePointer(1);
    auto *delayLeft = ring.getWritePointer(0),
         *delayRight = ring.getWritePointer(1);
    for (int i = 0; i < n; ++i) {
      std::swap(left[i], delayLeft[cursor]);
      std::swap(right[i], delayRight[cursor]);
      if (++cursor == size)
        cursor = 0;
    }
  }
};

struct Graph {
  struct Edge {
    int source;
    float gain;
    StereoDelay alignment;
  };
  struct Node {
    String id;
    std::unique_ptr<Effect> effect;
    AudioBuffer<float> buffer{2, blockSize};
    std::vector<Edge> incoming;
  };
  std::vector<std::unique_ptr<Node>> nodes;
  std::vector<int> order;
  AudioBuffer<float> aligned{2, blockSize};
  int output = 0, latency = 0;
  Graph(const Json &graph, AudioPluginFormatManager &formats, double sr) {
    require(graph.isObject() && graph["schema_version"] == var(3),
            "Graph must use schema_version 3");
    auto *chain = graph["chain"].getArray();
    auto routing = graph["routing"];
    require(chain && chain->size() <= 32 && routing.isObject(),
            "Invalid effect graph");
    for (const auto &property : routing.getDynamicObject()->getProperties())
      require(property.name == Identifier("mixers") ||
                  property.name == Identifier("links") ||
                  property.name == Identifier("positions"),
              "Unknown graph routing field");
    auto *mixers = routing["mixers"].getArray();
    auto *links = routing["links"].getArray();
    require(mixers && mixers->size() <= 8 && links && links->size() <= 96,
            "Invalid graph routing");
    std::map<String, int> ids;
    auto add = [&](String id, bool endpoint = false) {
      require(endpoint || validId(id), "Invalid node ID");
      require(ids.count(id) == 0, "Duplicate graph node ID");
      auto node = std::make_unique<Node>();
      node->id = id;
      ids[id] = (int)nodes.size();
      nodes.push_back(std::move(node));
    };
    add("@input", true);
    for (const auto &item : *chain) {
      add(string(item, "id"));
      nodes.back()->effect = std::make_unique<Effect>(item, formats, sr);
    }
    std::set<String> mixerIds;
    for (const auto &id : *mixers) {
      require(id.isString(), "Mixer ID must be string");
      add(id.toString());
      mixerIds.insert(id.toString());
    }
    add("@output", true);
    output = (int)nodes.size() - 1;
    std::vector<std::vector<int>> outgoing(nodes.size());
    std::vector<int> degree(nodes.size(), 0);
    std::set<std::pair<int, int>> seen;
    for (const auto &edge : *links) {
      require(edge.isObject() &&
                  edge.getDynamicObject()->getProperties().size() == 3,
              "Invalid routing edge");
      auto source = string(edge, "source"), target = string(edge, "target");
      auto g = number(edge, "gain_db", -60, 12);
      require(ids.count(source) && ids.count(target) && source != "@output" &&
                  target != "@input" && source != target,
              "Invalid routing endpoint");
      int s = ids[source], t = ids[target];
      require(seen.insert({s, t}).second, "Duplicate routing edge");
      require(mixerIds.count(target) || g == 0,
              "Branch gain is allowed only into mixers");
      nodes[(size_t)t]->incoming.push_back({s, gain(g), {}});
      outgoing[(size_t)s].push_back(t);
      ++degree[(size_t)t];
    }
    for (size_t i = 0; i < nodes.size(); ++i) {
      auto &node = *nodes[i];
      require(i == 0 || !node.incoming.empty(),
              "Graph node missing input: " + node.id);
      require((int)i == output || !outgoing[i].empty(),
              "Graph node missing output: " + node.id);
      require(mixerIds.count(node.id) ? degree[i] >= 2 : degree[i] <= 1,
              "Multiple inputs require a mixer node");
    }
    for (size_t i = 0; i < nodes.size(); ++i)
      if (degree[i] == 0)
        order.push_back((int)i);
    for (size_t i = 0; i < order.size(); ++i)
      for (int to : outgoing[(size_t)order[i]])
        if (--degree[(size_t)to] == 0)
          order.push_back(to);
    require(order.size() == nodes.size(), "Graph contains a cycle");
    auto positions = routing["positions"];
    require(positions.isObject(), "Graph positions must be object");
    for (const auto &prop : positions.getDynamicObject()->getProperties()) {
      auto *a = prop.value.getArray();
      require(ids.count(prop.name.toString()) && a && a->size() == 2,
              "Invalid graph position");
      for (const auto &x : *a)
        require((x.isDouble() || x.isInt() || x.isInt64()) &&
                    std::isfinite((double)x) && std::abs((double)x) <= 1000000,
                "Invalid graph coordinate");
    }
    alignBranches();
  }
  void alignBranches() {
    std::vector<int> latencies(nodes.size());
    for (int index : order) {
      auto &node = *nodes[(size_t)index];
      int inputLatency = 0;
      for (const auto &edge : node.incoming)
        inputLatency = std::max(inputLatency, latencies[(size_t)edge.source]);
      for (auto &edge : node.incoming)
        edge.alignment.configure(inputLatency - latencies[(size_t)edge.source]);
      latencies[(size_t)index] =
          inputLatency + (node.effect ? node.effect->latency() : 0);
    }
    latency = latencies[(size_t)output];
  }
  void prepare(double sr) {
    for (auto &node : nodes)
      if (node->effect)
        node->effect->prepare(sr);
    alignBranches();
  }
  void reset() {
    for (auto &node : nodes) {
      if (node->effect)
        node->effect->reset();
      for (auto &edge : node->incoming)
        edge.alignment.reset();
    }
  }
  void process(AudioBuffer<float> &input, int n) {
    for (int c = 0; c < 2; ++c)
      nodes[0]->buffer.copyFrom(c, 0, input, c, 0, n);
    for (int index : order)
      if (index != 0) {
        auto &node = *nodes[(size_t)index];
        node.buffer.clear();
        for (auto &edge : node.incoming) {
          auto *source = &nodes[(size_t)edge.source]->buffer;
          if (edge.alignment.ring.getNumSamples() > 0) {
            for (int c = 0; c < 2; ++c)
              aligned.copyFrom(c, 0, *source, c, 0, n);
            edge.alignment.process(aligned, n);
            source = &aligned;
          }
          for (int c = 0; c < 2; ++c)
            node.buffer.addFrom(c, 0, *source, c, 0, n, edge.gain);
        }
        if (node.effect)
          node.effect->process(node.buffer, n);
      }
    for (int c = 0; c < 2; ++c)
      input.copyFrom(c, 0, nodes[(size_t)output]->buffer, c, 0, n);
  }
};

struct Source {
  AudioBuffer<float> audio;
  Json waveform;
  double rate;
  double duration() const { return audio.getNumSamples() * 1000.0 / rate; }
  void buildWaveform() {
    const int samples = audio.getNumSamples(), count = std::min(8192, samples);
    Array<var> peaks;
    for (int i = 0; i < count; ++i) {
      const int begin = (int)((int64)i * samples / count),
                end = (int)((int64)(i + 1) * samples / count);
      float low = 0, high = 0;
      for (int c = 0; c < 2; ++c) {
        auto range = audio.findMinMax(c, begin, end - begin);
        low = std::min(low, range.getStart());
        high = std::max(high, range.getEnd());
      }
      peaks.add(pair(low, high));
    }
    waveform = object();
    put(waveform, "duration", duration());
    put(waveform, "peaks", peaks);
  }
};
double tailDuration(const Json &strip, const Json &graph) {
  if (!boolean(strip, "fxEnabled", true))
    return 0;
  if (auto *chain = graph["chain"].getArray())
    for (const auto &effect : *chain)
      if (boolean(effect, "enabled", true) &&
          (effect["effect"].toString() == "delay" ||
           effect["effect"].toString() == "reverb"))
        return 2000;
  return 0;
}
struct Preview {
  Json data;
  std::shared_ptr<Graph> graph;
};
bool sameGraph(const Json &a, const Json &b) {
  return JSON::toString(a, true) == JSON::toString(b, true);
}
double nearestClipStart(const Array<var> &clips, double wanted, double length) {
  std::vector<std::pair<double, double>> intervals;
  for (const auto &item : clips) {
    auto start = number(item, "start", 0, 86400000);
    auto duration = number(item, "duration", 0, 86400000);
    intervals.emplace_back(start, start + duration);
  }
  std::sort(intervals.begin(), intervals.end());
  double best = 0, distance = std::numeric_limits<double>::infinity(), lower = 0;
  for (const auto &interval : intervals) {
    const double upper = interval.first - length;
    if (upper >= lower - .0001) {
      auto candidate = std::clamp(wanted, lower, std::max(lower, upper));
      if (std::abs(candidate - wanted) < distance) { best = candidate; distance = std::abs(candidate - wanted); }
    }
    lower = std::max(lower, interval.second);
  }
  auto candidate = std::max(wanted, lower);
  if (std::abs(candidate - wanted) < distance) best = candidate;
  require(best <= 86400000, "Clip start exceeds timeline limit");
  return best;
}
struct Clip {
  String id, path;
  double start = 0;
  std::shared_ptr<Source> source;
};
struct Track {
  Json data;
  std::vector<Clip> clips;
  std::shared_ptr<Source> source;
  std::shared_ptr<Graph> graph;
  Preview preview;
  std::array<float, 2> level{};
  double end = 0;
  StereoDelay alignment;
  const std::shared_ptr<Graph> &activeGraph() const {
    return preview.graph ? preview.graph : graph;
  }
  int latency() const {
    return boolean(data, "fxEnabled", true) ? activeGraph()->latency : 0;
  }
};
struct Session {
  String auditionTrack;
  Json project;
  std::vector<Track> tracks;
  std::shared_ptr<Graph> master;
  Preview masterPreview;
  double rate = 44100, duration = 0;
  AudioBuffer<float> scratch{2, blockSize}, discard{2, blockSize};
  int latency = 0;
  bool primed = false;
  Session(Json p, AudioFormatManager &formats,
          AudioPluginFormatManager &plugins, double sr,
          const Session *previous = nullptr, bool reuseGraphs = true,
          const String &committedChannel = {})
      : project(copy(p)), rate(sr) {
    require(project.isObject() && project["schemaVersion"] == var(1),
            "Unsupported project schema");
    string(project, "name");
    number(project, "sampleRate", 8000, 384000);
    put(project, "sampleRate", sr);
    auto *list = project["tracks"].getArray();
    require(list && list->size() <= 256,
            "Project tracks must be an array of up to 256 tracks");
    std::set<String> ids;
    std::map<String, std::shared_ptr<Source>> sources;
    if (previous)
      for (const auto &old : previous->tracks)
        for (const auto &clip : old.clips)
          sources.emplace(clip.path, clip.source);
    auto emptyWaveform = object();
    put(emptyWaveform, "duration", 0.0);
    put(emptyWaveform, "peaks", Array<var>{});
    for (auto &t : *list) {
      auto id = string(t, "id");
      require(validId(id) && ids.insert(id).second,
              "Invalid or duplicate track ID");
      string(t, "label");
      validateStrip(t);
      auto media = t["source"];
      require(has(t, "source") && (media.isVoid() || media.isString()),
              "Track source must be a path or null");
      if (media.isString())
        require(File::isAbsolutePath(media.toString()) && File(media.toString()).existsAsFile(), "Track source must be an existing absolute file");
      if (!has(t, "clips")) {
        Array<var> legacy;
        if (media.isString()) {
          auto clip = object();
          put(clip, "id", "clip_" + Uuid().toString().removeCharacters("-"));
          put(clip, "source", media);
          put(clip, "start", 0.0);
          legacy.add(clip);
        }
        put(t, "clips", legacy);
      }
      auto *clipData = t["clips"].getArray();
      require(clipData && clipData->size() <= 1024, "Invalid track clips");
      Track track;
      if (previous && reuseGraphs)
        for (const auto &old : previous->tracks) {
          if (id != old.data["id"].toString()) continue;
          if (id != committedChannel) track.preview = old.preview;
          else if (old.preview.graph && sameGraph(old.preview.data, t["graph"]))
            track.graph = old.preview.graph;
          if (!track.graph && sameGraph(old.data["graph"], t["graph"])) track.graph = old.graph;
          break;
        }
      std::set<String> clipIds;
      double clipEnd = 0;
      for (auto &item : *clipData) {
        require(item.isObject(), "Invalid clip");
        Clip clip;
        clip.id = string(item, "id");
        require(validId(clip.id) && clipIds.insert(clip.id).second, "Invalid or duplicate clip ID");
        clip.path = string(item, "source");
        clip.start = number(item, "start", 0, 86400000);
        require(File::isAbsolutePath(clip.path) && File(clip.path).existsAsFile(), "Clip source must be an existing absolute file");
        if (auto cached = sources.find(clip.path); cached != sources.end()) clip.source = cached->second;
        if (!clip.source) {
          std::unique_ptr<AudioFormatReader> reader(formats.createReaderFor(File(clip.path)));
          require(reader != nullptr, "Cannot decode audio: " + clip.path);
          require(reader->sampleRate >= 8000 && reader->sampleRate <= 384000 && reader->lengthInSamples > 0 &&
                      reader->lengthInSamples <= std::numeric_limits<int>::max(), "Unsupported audio length or sample rate");
          clip.source = std::make_shared<Source>();
          clip.source->rate = reader->sampleRate;
          clip.source->audio.setSize(2, (int)reader->lengthInSamples);
          require(reader->read(&clip.source->audio, 0, (int)reader->lengthInSamples, 0, true, true), "Audio decode failed: " + clip.path);
          if (reader->numChannels == 1) clip.source->audio.copyFrom(1, 0, clip.source->audio, 0, 0, clip.source->audio.getNumSamples());
          for (int c = 0; c < 2; ++c) {
            const auto *samples = clip.source->audio.getReadPointer(c);
            for (int i = 0; i < clip.source->audio.getNumSamples(); ++i)
              require(std::isfinite(samples[i]), "Audio contains non-finite samples");
          }
          clip.source->buildWaveform();
          sources.emplace(clip.path, clip.source);
        }
        for (const auto &other : track.clips)
          require(clip.start + .001 >= other.start + other.source->duration() ||
                      other.start + .001 >= clip.start + clip.source->duration(), "Clips cannot overlap");
        put(item, "duration", clip.source->duration());
        put(item, "waveform", clip.source->waveform);
        clipEnd = std::max(clipEnd, clip.start + clip.source->duration());
        track.clips.push_back(std::move(clip));
      }
      track.source = track.clips.empty() ? nullptr : track.clips.front().source;
      put(t, "source", track.clips.empty() ? Json() : Json(track.clips.front().path));
      if (!track.graph)
        track.graph = std::make_shared<Graph>(t["graph"], plugins, sr);
      put(t, "waveform", track.source ? track.source->waveform : emptyWaveform);
      put(t, "duration", track.source ? clipEnd + tailDuration(t, t["graph"]) : 0.0);
      track.data = t;
      tracks.push_back(std::move(track));
    }
    auto masterData = project["master"];
    if (!has(masterData, "pan")) put(masterData, "pan", 0);
    if (!has(masterData, "solo")) put(masterData, "solo", false);
    validateStrip(masterData);
    if (previous && reuseGraphs) {
      if (committedChannel != "master")
        masterPreview = previous->masterPreview;
      else if (previous->masterPreview.graph &&
               sameGraph(previous->masterPreview.data, masterData["graph"]))
        master = previous->masterPreview.graph;
      if (!master && sameGraph(previous->project["master"]["graph"],
                               masterData["graph"]))
        master = previous->master;
    }
    if (!master)
      master = std::make_shared<Graph>(masterData["graph"], plugins, sr);
    updateDuration();
    if (!has(project, "loop")) put(project, "loop", JSON::parse(R"({"start":0,"end":0,"enabled":false})"));
    auto loop = project["loop"];
    require(loop.isObject(), "Invalid loop selection");
    const auto loopStart = number(loop, "start", 0, 86400000);
    const auto loopEnd = number(loop, "end", 0, 86400000);
    const auto enabled = boolean(loop, "enabled");
    require(loopEnd >= loopStart && (!enabled || loopEnd - loopStart >= 50), "Invalid loop selection");
    const auto boundedStart = std::min(loopStart, duration), boundedEnd = std::min(loopEnd, duration);
    put(loop, "start", boundedStart);
    put(loop, "end", boundedEnd);
    put(loop, "enabled", enabled && boundedEnd - boundedStart >= 50);
    alignTracks();
  }
  static void validateStrip(const Json &t) {
    require(t.isObject(), "Invalid channel strip");
    number(t, "gainDb", -100, 24);
    boolean(t, "muted");
    boolean(t, "fxEnabled", true);
    number(t, "pan", -1, 1);
    boolean(t, "solo");
  }
  const std::shared_ptr<Graph> &activeMaster() const {
    return masterPreview.graph ? masterPreview.graph : master;
  }
  int masterLatency() const {
    return duration > 0 && boolean(project["master"], "fxEnabled", true)
               ? activeMaster()->latency
               : 0;
  }
  void updateDuration() {
    duration = 0;
    for (auto &t : tracks) {
      t.end = 0;
      for (const auto &clip : t.clips) t.end = std::max(t.end, clip.start + clip.source->duration());
      if (t.source) t.end += tailDuration(t.data, t.preview.graph ? t.preview.data : t.data["graph"]);
      duration = std::max(duration, t.end);
    }
    if (duration > 0) {
      auto m = project["master"];
      duration += tailDuration(m, masterPreview.graph ? masterPreview.data
                                                      : m["graph"]);
    }
  }
  void prepare(double sr) {
    rate = sr;
    for (auto &t : tracks) {
      t.graph->prepare(sr);
      if (t.preview.graph)
        t.preview.graph->prepare(sr);
    }
    master->prepare(sr);
    if (masterPreview.graph)
      masterPreview.graph->prepare(sr);
    alignTracks();
  }
  void alignTracks() {
    int trackLatency = 0;
    for (const auto &t : tracks)
      if (t.source)
        trackLatency = std::max(trackLatency, t.latency());
    for (auto &t : tracks)
      if (t.source)
        t.alignment.configure(trackLatency - t.latency());
    latency = trackLatency + masterLatency();
    primed = false;
  }
  bool inheritPlayback(Session &previous) {
    if (latency != previous.latency ||
        (masterLatency() > 0 && activeMaster() != previous.activeMaster()) ||
        tracks.size() < previous.tracks.size() ||
        masterLatency() != previous.masterLatency())
      return false;
    for (size_t i = 0; i < tracks.size(); ++i) {
      const auto &t = tracks[i];
      if (i >= previous.tracks.size()) {
        if (t.source)
          return false;
        continue;
      }
      const auto &old = previous.tracks[i];
      if (t.clips.size() != old.clips.size()) return false;
      for (size_t j = 0; j < t.clips.size(); ++j)
        if (t.clips[j].source != old.clips[j].source || t.clips[j].start != old.clips[j].start) return false;
      if (t.source != old.source ||
          (t.source && (t.latency() != old.latency() ||
                        (t.latency() > 0 && t.activeGraph() != old.activeGraph()))))
        return false;
    }
    for (size_t i = 0; i < previous.tracks.size(); ++i)
      if (tracks[i].source)
        tracks[i].alignment = std::move(previous.tracks[i].alignment);
    primed = previous.primed;
    return true;
  }
  void reset() {
    for (auto &t : tracks) {
      t.activeGraph()->reset();
      t.alignment.reset();
      t.level = {0, 0};
    }
    activeMaster()->reset();
    primed = false;
  }
  void prime(double position) {
    if (primed || latency == 0)
      return;
    // Discard DSP pre-roll so transport and rendered files use source time.
    const double msPerSample = 1000.0 / rate;
    const int history =
        (int)std::min<double>(latency, std::floor(position / msPerSample));
    for (int offset = -history; offset < latency; offset += blockSize)
      renderBlock(discard, std::min(blockSize, latency - offset),
                  position + offset * msPerSample, "", nullptr);
    primed = true;
  }
  void render(AudioBuffer<float> &out, int n, double position,
              const String &spectrumSource,
              AudioBuffer<float> *selected = nullptr) {
    prime(position);
    renderBlock(out, n, position + latency * 1000.0 / rate, spectrumSource,
                selected);
  }
  void renderBlock(AudioBuffer<float> &out, int n, double position,
                   const String &spectrumSource, AudioBuffer<float> *selected) {
    out.clear();
    auto m = project["master"];
    bool solo = false;
    for (const auto &t : tracks)
      solo = solo || (t.source && boolean(t.data, "solo"));
    if (boolean(m, "solo")) solo = false;
    if (selected)
      selected->clear();
    for (auto &t : tracks) {
      if (!t.source)
        continue;
      scratch.clear();
      bool audible = !boolean(t.data, "muted") &&
          (auditionTrack.isNotEmpty() ? t.data["id"].toString() == auditionTrack
                                     : (!solo || boolean(t.data, "solo")));
      for (const auto &clip : t.clips) {
        double start = (position - clip.start) * clip.source->rate * .001,
               increment = clip.source->rate / rate;
        for (int i = 0; i < n; ++i) {
          double x = start + i * increment;
          auto index = (int64)std::floor(x);
          float frac = (float)(x - index);
          if (index >= 0 && index < clip.source->audio.getNumSamples())
            for (int c = 0; c < 2; ++c) {
              float a = clip.source->audio.getSample(c, (int)index),
                    b = index + 1 < clip.source->audio.getNumSamples() ? clip.source->audio.getSample(c, (int)index + 1) : 0;
              scratch.addSample(c, i, a + (b - a) * frac);
            }
        }
      }
      if (boolean(t.data, "fxEnabled", true))
        t.activeGraph()->process(scratch, n);
      // The legacy renderer gives each strip a fixed two-second tail budget.
      const double trackTime = position - t.latency() * 1000.0 / rate;
      for (int i = 0; i < n; ++i)
        if (trackTime + i * 1000.0 / rate >= t.end) {
          scratch.setSample(0, i, 0);
          scratch.setSample(1, i, 0);
        }
      t.alignment.process(scratch, n);
      float amplitude = audible ? gain((double)t.data["gainDb"]) : 0,
            pan = (float)(double)t.data["pan"];
      scratch.applyGain(0, 0, n,
                        amplitude * std::sqrt(1 - std::max(0.0f, pan)));
      scratch.applyGain(1, 0, n,
                        amplitude * std::sqrt(1 + std::min(0.0f, pan)));
      for (int c = 0; c < 2; ++c) {
        if (selected)
          t.level[(size_t)c] = std::max(t.level[(size_t)c], scratch.getMagnitude(c, 0, n));
        out.addFrom(c, 0, scratch, c, 0, n);
      }
      if (selected && t.data["id"].toString() == spectrumSource)
        for (int c = 0; c < 2; ++c)
          selected->copyFrom(c, 0, scratch, c, 0, n);
    }
    if (boolean(m, "fxEnabled", true))
      activeMaster()->process(out, n);
    const auto amplitude = boolean(m, "muted") ? 0.0f : gain((double)m["gainDb"]);
    const auto pan = (float)(double)m["pan"];
    out.applyGain(0, 0, n, amplitude * std::sqrt(1 - std::max(0.0f, pan)));
    out.applyGain(1, 0, n, amplitude * std::sqrt(1 + std::min(0.0f, pan)));
    if (selected && spectrumSource == "master")
      for (int c = 0; c < 2; ++c)
        selected->copyFrom(c, 0, out, c, 0, n);
  }
};

class Engine : public AudioIODeviceCallback {
public:
  AudioFormatManager formats;
  AudioPluginFormatManager plugins;
  AudioDeviceManager devices;
  std::unique_ptr<Session> session;
  std::mutex mutex;
  bool playing = false, deviceOpen = false, callbackAdded = false;
  double position = 0;
  std::atomic<double> rate{44100};
  String spectrumSource = "master";
  String playbackSource = "master";
  double loopStart = 0, loopEnd = 0;
  bool loopEnabled = false;
  std::array<float, 2> masterLevel{};
  bool overload = false;
  AudioBuffer<float> output{2, blockSize}, selected{2, blockSize};
  using SpectrumRing = std::array<std::array<float, 2048>, 2>;
  SpectrumRing fftRing{}, masterFftRing{};
  int fftWrite = 0, fftFilled = 0;
  dsp::FFT fft{11};
  Engine() {
    formats.registerBasicFormats();
    addDefaultFormatsToManager(plugins);
    session = std::make_unique<Session>(newProject(), formats, plugins, rate);
  }
  ~Engine() override { closeDevice(); }
  void closeDevice() {
    if (callbackAdded)
      devices.removeAudioCallback(this);
    callbackAdded = false;
    devices.closeAudioDevice();
    deviceOpen = false;
  }
  void audioDeviceAboutToStart(AudioIODevice *device) override {
    std::lock_guard<std::mutex> lock(mutex);
    rate = device->getCurrentSampleRate();
    session->prepare(rate);
    if (playing)
      session->prime(position);
    clearTelemetry();
  }
  void audioDeviceStopped() override {}
  void audioDeviceError(const String &error) override {
    std::cerr << "audio device: " << error << std::endl;
  }
  void audioDeviceIOCallbackWithContext(
      const float *const *, int, float *const *outs, int channels, int samples,
      const AudioIODeviceCallbackContext &) override {
    for (int c = 0; c < channels; ++c)
      if (outs[c])
        FloatVectorOperations::clear(outs[c], samples);
    std::lock_guard<std::mutex> lock(mutex);
    if (!playing)
      return;
    for (int offset = 0; offset < samples;) {
      if (loopEnabled && position >= loopEnd) {
        position = loopStart;
        session->reset();
        session->prime(position);
      }
      int n = std::min(blockSize, samples - offset);
      if (position >= session->duration) {
        playing = false;
        clearTelemetry(true);
        break;
      }
      const auto boundary = loopEnabled ? std::min(loopEnd, session->duration) : session->duration;
      n = std::min(n,
                   std::max(1, (int)std::ceil((boundary - position) *
                                              rate * .001)));
      session->render(output, n, position, spectrumSource, &selected);
      for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i)
          if (!std::isfinite(output.getSample(c, i))) {
            output.setSample(c, i, 0);
            overload = true;
          }
      capture(n);
      for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i)
          output.setSample(c, i, jlimit(-1.0f, 1.0f, output.getSample(c, i)));
      for (int c = 0; c < std::min(2, channels); ++c)
        if (outs[c])
          FloatVectorOperations::copy(outs[c] + offset,
                                      output.getReadPointer(c), n);
      position = std::min(boundary, position + n * 1000.0 / rate);
      offset += n;
    }
  }
  void capture(int n) {
    for (int c = 0; c < 2; ++c) {
      const auto peak = output.getMagnitude(c, 0, n);
      masterLevel[(size_t)c] = std::max(masterLevel[(size_t)c], peak);
      overload = overload || peak > 1.0f;
    }
    for (int i = 0; i < n; ++i) {
      for (int c = 0; c < 2; ++c) {
        auto sample = selected.getSample(c, i);
        fftRing[(size_t)c][(size_t)fftWrite] =
            std::isfinite(sample) ? sample : 0;
        masterFftRing[(size_t)c][(size_t)fftWrite] = output.getSample(c, i);
      }
      fftWrite = (fftWrite + 1) % 2048;
      fftFilled = std::min(2048, fftFilled + 1);
    }
  }
  void clearTelemetry(bool preserveMeterPeaks = false) {
    overload = false;
    for (auto &channel : fftRing)
      channel.fill(0);
    for (auto &channel : masterFftRing)
      channel.fill(0);
    fftFilled = 0;
    fftWrite = 0;
    if (!preserveMeterPeaks) {
      masterLevel = {0, 0};
      for (auto &t : session->tracks)
        t.level = {0, 0};
    }
  }
  Json deviceList() {
    Array<var> list;
    auto def = object();
    put(def, "id", "");
    put(def, "label", "System default");
    put(def, "isDefault", true);
    list.add(def);
    for (auto *type : devices.getAvailableDeviceTypes()) {
#if JUCE_WINDOWS
      // Shared WASAPI exposes active playback endpoints; ASIO remains available
      // for professional interfaces. Other Windows modes duplicate endpoints.
      if (type->getTypeName() != "Windows Audio" && type->getTypeName() != "ASIO")
        continue;
#endif
      type->scanForDevices();
      for (auto name : type->getDeviceNames(false)) {
        auto *current = devices.getCurrentAudioDevice();
        const bool active = current && devices.getCurrentAudioDeviceType() == type->getTypeName() && current->getName() == name;
        if (!active && type->getTypeName() != "Windows Audio") {
          std::unique_ptr<AudioIODevice> candidate(type->createDevice(name, {}));
          if (!candidate || candidate->getOutputChannelNames().isEmpty() || candidate->getAvailableSampleRates().isEmpty())
            continue;
        }
        auto entry = object();
        put(entry, "id", type->getTypeName() + "::" + name);
        put(entry, "label", type->getTypeName() + " / " + name);
        put(entry, "isDefault", false);
        list.add(entry);
      }
    }
    return list;
  }
  void openDevice(const String &id) {
    String typeName, deviceName;
    if (id.isNotEmpty()) {
      auto separator = id.indexOf("::");
      require(separator > 0, "Unknown device ID");
      typeName = id.substring(0, separator);
      deviceName = id.substring(separator + 2);
      bool found = false;
      for (auto *type : devices.getAvailableDeviceTypes()) {
        if (type->getTypeName() != typeName) continue;
        type->scanForDevices();
        found = type->getDeviceNames(false).contains(deviceName);
        break;
      }
      require(found, "Unknown device ID");
    }
    // Device manager invokes callbacks while changing setup; never hold the
    // session lock here.
    String error;
    const bool wasOpen = deviceOpen;
    if (!deviceOpen) {
      error = devices.initialise(0, 2, nullptr, true);
      require(error.isEmpty(), "Audio device initialization failed: " + error);
      deviceOpen = true;
    }
    if (typeName.isNotEmpty())
      devices.setCurrentAudioDeviceType(typeName, true);
    AudioDeviceManager::AudioDeviceSetup setup;
    devices.getAudioDeviceSetup(setup);
    if (id.isEmpty()) {
      if (wasOpen) {
        devices.closeAudioDevice();
        error = devices.initialise(0, 2, nullptr, true);
        require(error.isEmpty(), "Default audio device failed: " + error);
        devices.getAudioDeviceSetup(setup);
      }
    } else {
      setup.outputDeviceName = deviceName;
      setup.inputDeviceName = "";
      setup.sampleRate = 0;
      setup.bufferSize = 0;
      setup.useDefaultOutputChannels = true;
      error = devices.setAudioDeviceSetup(setup, true);
      require(error.isEmpty(), "Cannot open device: " + error);
    }
    require(devices.getCurrentAudioDevice() != nullptr,
            "No output audio device available");
    if (!callbackAdded) {
      devices.addAudioCallback(this);
      callbackAdded = true;
    }
  }
  void replace(Json p, bool reloadSources = false,
               const String &committedChannel = {}) {
    // Decode, validate and instantiate all nodes before replacing the live
    // session.
    auto candidate = std::make_unique<Session>(
        p, formats, plugins, rate, reloadSources ? nullptr : session.get(),
        true, committedChannel);
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (candidate->rate != rate.load())
        candidate->prepare(rate.load());
      if (!reloadSources) {
        if ((candidate->latency > 0 || session->latency > 0) &&
            !candidate->inheritPlayback(*session))
          candidate->reset();
        for (auto &t : candidate->tracks)
          for (const auto &old : session->tracks)
            if (t.data["id"] == old.data["id"]) {
              t.level = old.level;
              break;
            }
      }
      session.swap(candidate);
      auto loop = session->project["loop"];
      loopStart = (double)loop["start"];
      loopEnd = (double)loop["end"];
      loopEnabled = boolean(loop, "enabled");
      if (playbackSource != "master") {
        bool found = false;
        for (const auto &track : session->tracks)
          found = found || (track.data["id"].toString() == playbackSource && track.source);
        if (!found) { playing = false; playbackSource = "master"; }
      }
      session->auditionTrack = playbackSource == "master" ? String() : playbackSource;
      position = std::min(position, session->duration);
      if (reloadSources) {
        playing = false;
        position = 0;
        spectrumSource = "master";
        playbackSource = "master";
        session->auditionTrack.clear();
      }
      if (playing)
        session->prime(position);
      else
        clearTelemetry();
    }
  }
  void previewGraph(const String &id, const Json &draft) {
    Track *track = nullptr;
    if (id != "master") {
      for (auto &t : session->tracks)
        if (t.data["id"] == id) {
          track = &t;
          break;
        }
      require(track != nullptr, "Unknown track ID");
    }
    auto &slot = track ? track->preview : session->masterPreview;
    if ((!slot.graph && draft.isVoid()) ||
        (slot.graph && sameGraph(slot.data, draft)))
      return;
    Preview compiled;
    const auto sampleRate = rate.load();
    if (!draft.isVoid())
      compiled = {copy(draft), std::make_shared<Graph>(draft, plugins, sampleRate)};
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (compiled.graph && sampleRate != rate.load())
        compiled.graph->prepare(rate.load());
      const int before = track ? track->latency() : session->masterLatency();
      std::swap(slot, compiled);
      session->updateDuration();
      const int after = track ? track->latency() : session->masterLatency();
      position = std::min(position, session->duration);
      if (before != after && (!track || track->source))
        session->alignTracks();
      if ((before > 0 || after > 0) && (!track || track->source)) {
        session->reset();
        if (playing)
          session->prime(position);
      } else if (!slot.graph) {
        // A restored committed graph may still hold history from before audition.
        (track ? track->graph : session->master)->reset();
      }
    }
  }
  Json spectrum(const SpectrumRing &pcm, int write, bool hasSamples,
                double sampleRate) {
    std::array<float, 1024> magnitudes{};
    if (hasSamples)
      for (const auto &channel : pcm) {
        std::array<float, 4096> data{};
        for (int i = 0; i < 2048; ++i)
          data[(size_t)i] = channel[(size_t)((write + i) % 2048)] *
                            (.5f - .5f * std::cos(MathConstants<float>::twoPi * i / 2047));
        fft.performFrequencyOnlyForwardTransform(data.data());
        for (int i = 1; i < 1024; ++i)
          magnitudes[(size_t)i] =
              std::max(magnitudes[(size_t)i], data[(size_t)i]);
      }
    std::vector<double> frequencies, values;
    frequencies.reserve(1023);
    values.reserve(1023);
    for (int i = 1; i < 1024; ++i) {
      frequencies.push_back(i * sampleRate / 2048.0);
      values.push_back(db(magnitudes[(size_t)i] / 512.0f));
    }
    auto result = object();
    put(result, "frequencies", array(frequencies));
    put(result, "db", array(values));
    return result;
  }
  Json state() {
    struct Snapshot {
      double position, duration, rate;
      bool playing, overload, masterSelected;
      String playbackSource;
      int write, filled, count;
      std::array<float, 2> master;
      std::array<String, 256> ids;
      std::array<std::array<float, 2>, 256> levels;
      SpectrumRing pcm, masterPcm;
    } snapshot;
    {
      std::lock_guard<std::mutex> lock(mutex);
      snapshot.position = position;
      snapshot.duration = session->duration;
      snapshot.rate = rate;
      snapshot.playing = playing;
      snapshot.playbackSource = playbackSource;
      snapshot.overload = overload;
      snapshot.masterSelected = spectrumSource == "master";
      snapshot.master = masterLevel;
      masterLevel = {};
      snapshot.write = fftWrite;
      snapshot.filled = fftFilled;
      snapshot.pcm = fftRing;
      snapshot.masterPcm = masterFftRing;
      snapshot.count = (int)session->tracks.size();
      for (int i = 0; i < snapshot.count; ++i) {
        auto &track = session->tracks[(size_t)i];
        snapshot.ids[(size_t)i] = track.data["id"].toString();
        snapshot.levels[(size_t)i] = track.level;
        track.level = {};
      }
    }
    auto s = object(), levels = object();
    put(s, "position", snapshot.position);
    put(s, "duration", snapshot.duration);
    put(s, "playing", snapshot.playing);
    put(s, "playbackSource", snapshot.playbackSource);
    for (int i = 0; i < snapshot.count; ++i)
      put(levels, snapshot.ids[(size_t)i],
          pair(db(snapshot.levels[(size_t)i][0]),
               db(snapshot.levels[(size_t)i][1])));
    put(s, "levels", levels);
    put(s, "master", pair(db(snapshot.master[0]), db(snapshot.master[1])));
    put(s, "overload", snapshot.overload);
    auto masterSpectrum =
        spectrum(snapshot.masterPcm, snapshot.write, snapshot.filled > 0, snapshot.rate);
    put(s, "masterSpectrum", masterSpectrum);
    put(s, "spectrum", snapshot.masterSelected ? masterSpectrum
                       : spectrum(snapshot.pcm, snapshot.write, snapshot.filled > 0,
                                  snapshot.rate));
    return s;
  }
  void checkExportPath(const String &path, const Json &project) {
    require(File::isAbsolutePath(path) && File(path).hasFileExtension("wav"),
            "Export needs an absolute .wav path");
    auto *tracks = project["tracks"].getArray();
    require(tracks && tracks->size() <= 256, "Invalid export project tracks");
    for (const auto &track : *tracks) {
      if (auto *clips = track["clips"].getArray()) {
        for (const auto &clip : *clips)
          require(File(string(clip, "source")) != File(path), "Export cannot overwrite source audio");
      } else if (track["source"].isString())
        require(File(string(track, "source")) != File(path), "Export cannot overwrite source audio");
    }
  }
  Json writeOfflineWav(Session &offline, const String &path, bool floating) {
    require(offline.duration > 0, "Cannot export an empty project");
    const double exportRate = offline.rate;
    File destination(path);
    require(destination.getParentDirectory().isDirectory(),
            "Export directory does not exist");
    TemporaryFile temp(destination);
    std::unique_ptr<OutputStream> stream = temp.getFile().createOutputStream();
    require(stream != nullptr, "Cannot create export temporary file");
    WavAudioFormat wav;
    auto options =
        AudioFormatWriterOptions{}
            .withSampleRate(exportRate)
            .withNumChannels(2)
            .withBitsPerSample(floating ? 32 : 24)
            .withSampleFormat(
                floating ? AudioFormatWriterOptions::SampleFormat::floatingPoint
                         : AudioFormatWriterOptions::SampleFormat::integral);
    auto writer = wav.createWriterFor(stream, options);
    require(writer != nullptr, "Cannot create WAV writer");
    AudioBuffer<float> buffer(2, blockSize);
    int64 total = (int64)std::ceil(offline.duration * exportRate * .001);
    for (int64 start = 0; start < total; start += blockSize) {
      int n = (int)std::min<int64>(blockSize, total - start);
      offline.render(buffer, n, start * 1000.0 / exportRate, "master");
      for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i) {
          auto sample = buffer.getSample(c, i);
          require(std::isfinite(sample), "Non-finite export audio");
          if (!floating)
            buffer.setSample(c, i, jlimit(-1.0f, 1.0f, sample));
        }
      require(writer->writeFromAudioSampleBuffer(buffer, 0, n),
              "Export write failed");
    }
    require(writer->flush(), "Export flush failed");
    writer.reset();
#if JUCE_WINDOWS
    require(MoveFileExW(temp.getFile().getFullPathName().toWideCharPointer(),
                        destination.getFullPathName().toWideCharPointer(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) !=
                0,
            "Cannot atomically commit export");
#else
    require(std::rename(temp.getFile().getFullPathName().toRawUTF8(),
                        destination.getFullPathName().toRawUTF8()) == 0,
            "Cannot atomically commit export");
#endif
    auto result = object();
    put(result, "path", path);
    put(result, "frames", total);
    put(result, "sampleRate", exportRate);
    put(result, "seconds", (double)total / exportRate);
    return result;
  }
  Json exportFile(const String &path) {
    checkExportPath(path, session->project);
    Session offline(session->project, formats, plugins, rate.load(),
                    session.get(), false);
    writeOfflineWav(offline, path, false);
    return true;
  }
  Json renderTrack(const Json &project, const String &id, const Json &graph,
                   const String &path, bool candidate, bool snapshot = false) {
    require(project.isObject() && project["schemaVersion"] == var(1),
            "Unsupported project schema");
    checkExportPath(path, project);
    checkExportPath(path, session->project);
    if (id == "master" && candidate) {
      auto mixed = copy(project);
      auto masterData = mixed["master"];
      require(masterData.isObject(), "Invalid master channel");
      put(masterData, "gainDb", 0);
      put(masterData, "pan", 0);
      put(masterData, "muted", false);
      put(masterData, "fxEnabled", true);
      put(masterData, "graph", graph);
      Session offline(mixed, formats, plugins,
                      number(project, "sampleRate", 8000, 384000),
                      session.get(), false);
      return writeOfflineWav(offline, path, true);
    }
    Json track;
    for (const auto &entry : *project["tracks"].getArray())
      if (entry["id"].toString() == id) {
        require(track.isVoid(), "Duplicate track ID");
        track = copy(entry);
      }
    require(track.isObject(), "Unknown track ID");
    require(track["source"].isString(), "Cannot render an empty track");
    put(track, "muted", false);
    put(track, "solo", false);
    if (candidate) {
      put(track, "gainDb", 0);
      put(track, "pan", 0);
      put(track, "fxEnabled", true);
      put(track, "graph", graph);
    }
    auto isolated = newProject();
    put(isolated, "tracks", Array<var>{track});
    const auto sampleRate = candidate || snapshot
                                ? number(project, "sampleRate", 8000, 384000)
                                : rate.load();
    Session offline(isolated, formats, plugins, sampleRate, session.get(),
                    false);
    return writeOfflineWav(offline, path, candidate);
  }
  Json handle(const Json &request) {
    require(request.isObject(), "Request must be an object");
    auto cmd = string(request, "command");
    if (cmd == "project") {
      auto p = copy(session->project);
      std::lock_guard<std::mutex> lock(mutex);
      put(p, "sampleRate", rate.load());
      return p;
    }
    if (cmd == "state")
      return state();
    if (cmd == "devices")
      return deviceList();
    if (cmd == "set_device") {
      openDevice(string(request, "id"));
      return true;
    }
    if (cmd == "play") {
      const bool explicitPosition = has(request, "position");
      const auto start =
          explicitPosition ? number(request, "position", 0, session->duration) : 0;
      const auto source = has(request, "trackId") ? string(request, "trackId") : String("master");
      if (source != "master") {
        bool found = false;
        for (const auto &track : session->tracks)
          found = found || (track.data["id"].toString() == source && track.source);
        require(found, "Unknown or empty audition track");
      }
      if (session->duration == 0)
        return true;
      if (!deviceOpen && (!explicitPosition || start < session->duration))
        openDevice("");
      std::lock_guard<std::mutex> lock(mutex);
      if (playbackSource != source) {
        playbackSource = source;
        session->auditionTrack = source == "master" ? String() : source;
        session->reset();
      }
      if (!playing || explicitPosition) {
        if (explicitPosition || position >= session->duration) {
          position = start;
          session->reset();
          clearTelemetry();
        }
        playing = position < session->duration;
        if (playing)
          session->prime(position);
      }
      return true;
    }
    if (cmd == "pause") {
      std::lock_guard<std::mutex> lock(mutex);
      playing = false;
      clearTelemetry();
      return true;
    }
    if (cmd == "stop") {
      std::lock_guard<std::mutex> lock(mutex);
      playing = false;
      position = 0;
      session->reset();
      clearTelemetry();
      return true;
    }
    if (cmd == "seek") {
      auto p = number(request, "position", 0, session->duration);
      std::lock_guard<std::mutex> lock(mutex);
      position = p;
      session->reset();
      if (playing)
        session->prime(position);
      clearTelemetry();
      return true;
    }
    if (cmd == "set_loop") {
      const auto start = number(request, "start", 0, session->duration);
      const auto end = number(request, "end", 0, session->duration);
      require(has(request, "enabled"), "Missing loop enabled state");
      const auto enabled = boolean(request, "enabled");
      require(end >= start && (!enabled || end - start >= 50), "Invalid loop selection");
      std::lock_guard<std::mutex> lock(mutex);
      auto loop = object();
      put(loop, "start", start); put(loop, "end", end); put(loop, "enabled", enabled);
      put(session->project, "loop", loop);
      loopStart = start; loopEnd = end; loopEnabled = enabled;
      return copy(session->project);
    }
    if (cmd == "set_spectrum") {
      auto source = string(request, "source");
      bool found = source == "master";
      for (auto &t : session->tracks)
        found = found || source == t.data["id"].toString();
      require(found, "Unknown spectrum source");
      std::lock_guard<std::mutex> lock(mutex);
      if (spectrumSource == source)
        return true;
      spectrumSource = source;
      for (auto &channel : fftRing)
        channel.fill(0);
      return true;
    }
    if (cmd == "preview_graph") {
      require(has(request, "graph"), "Preview graph is required");
      previewGraph(string(request, "id"), request["graph"]);
      return true;
    }
    if (cmd == "load_project") {
      replace(request["project"], true);
      return copy(session->project);
    }
    if (cmd == "restore_tracks") {
      require(request["tracks"].isArray(), "Tracks must be an array");
      auto p = copy(session->project);
      put(p, "tracks", copy(request["tracks"]));
      replace(p);
      bool found = spectrumSource == "master";
      for (const auto &track : *session->project["tracks"].getArray())
        found = found || track["id"].toString() == spectrumSource;
      if (!found)
        spectrumSource = "master";
      return copy(session->project);
    }
    if (cmd == "paste_track") {
      require(request["track"].isObject(), "Track must be an object");
      auto p = copy(session->project);
      auto *tracks = p["tracks"].getArray();
      auto track = copy(request["track"]);
      put(track, "id", "track_" + Uuid().toString().removeCharacters("-"));
      put(track, "label", track["label"].toString() + " 副本");
      put(track, "customLabel", true);
      auto after = request["after"].toString();
      int index = 0;
      while (index < tracks->size() && (*tracks)[index]["id"].toString() != after)
        ++index;
      tracks->insert(index < tracks->size() ? index + 1 : tracks->size(), track);
      replace(p);
      return copy(session->project);
    }
    if (cmd == "add_track") {
      auto p = copy(session->project);
      auto *tracks = p["tracks"].getArray();
      tracks->add(newTrack("Track " + String(tracks->size() + 1)));
      replace(p);
      return copy(session->project);
    }
    if (cmd == "duplicate_track" || cmd == "remove_track") {
      auto p = copy(session->project);
      auto *tracks = p["tracks"].getArray();
      const auto id = string(request, "id");
      int index = 0;
      while (index < tracks->size() && (*tracks)[index]["id"].toString() != id)
        ++index;
      require(index < tracks->size(), "Unknown track ID");
      if (cmd == "duplicate_track") {
        auto duplicate = copy((*tracks)[index]);
        put(duplicate, "id", "track_" + Uuid().toString().removeCharacters("-"));
        put(duplicate, "label", (*tracks)[index]["label"].toString() + " 副本");
        put(duplicate, "customLabel", true);
        tracks->insert(index + 1, duplicate);
      } else {
        tracks->remove(index);
      }
      replace(p);
      if (cmd == "remove_track" && spectrumSource == id)
        spectrumSource = "master";
      return copy(session->project);
    }
    if (cmd == "import") {
      auto *paths = request["paths"].getArray();
      require(paths && !paths->isEmpty(), "Import paths must be a nonempty array");
      auto p = copy(session->project);
      auto *tracks = p["tracks"].getArray();
      int index = -1;
      if (has(request, "trackId")) {
        auto target = string(request, "trackId");
        for (int i = 0; i < tracks->size(); ++i)
          if ((*tracks)[i]["id"].toString() == target) { index = i; break; }
        require(index >= 0, "Unknown track ID");
      }
      double wanted = has(request, "position") ? number(request, "position", 0, 86400000) : -1;
      std::map<String, double> knownDurations;
      for (const auto &existingTrack : session->tracks)
        for (const auto &existingClip : existingTrack.clips)
          knownDurations.emplace(existingClip.path, existingClip.source->duration());
      for (const auto &path : *paths) {
        require(path.isString() && File::isAbsolutePath(path.toString()), "Audio path must be absolute");
        const auto sourcePath = path.toString();
        auto known = knownDurations.find(sourcePath);
        double duration;
        if (known != knownDurations.end()) {
          duration = known->second;
        } else {
          auto reader = std::unique_ptr<AudioFormatReader>(formats.createReaderFor(File(sourcePath)));
          require(reader && reader->sampleRate >= 8000 && reader->sampleRate <= 384000 && reader->lengthInSamples > 0,
                  "Cannot decode audio: " + sourcePath);
          duration = reader->lengthInSamples * 1000.0 / reader->sampleRate;
          knownDurations.emplace(sourcePath, duration);
        }
        auto label = File(path.toString()).getFileNameWithoutExtension();
        auto track = index < 0 ? newTrack(label) : (*tracks)[index];
        auto *clips = track["clips"].getArray();
        require(clips != nullptr, "Invalid track clips");
        if (wanted < 0) {
          wanted = 0;
          for (const auto &clip : *clips) wanted = std::max(wanted, (double)clip["start"] + (double)clip["duration"]);
        }
        auto clip = object();
        put(clip, "id", "clip_" + Uuid().toString().removeCharacters("-"));
        put(clip, "source", path);
        put(clip, "start", nearestClipStart(*clips, wanted, duration));
        put(clip, "duration", duration);
        if (clips->isEmpty() && !boolean(track, "customLabel")) put(track, "label", label);
        clips->add(clip);
        put(track, "source", (*clips)[0]["source"]);
        if (index < 0) { tracks->add(track); wanted = -1; }
        else wanted = (double)clip["start"] + duration;
      }
      replace(p);
      return copy(session->project);
    }
    if (cmd == "move_clip") {
      auto p = copy(session->project);
      auto *tracks = p["tracks"].getArray();
      const auto from = string(request, "fromTrack"), id = string(request, "clipId");
      const auto to = has(request, "toTrack") ? string(request, "toTrack") : String();
      Json fromTrack, toTrack;
      for (auto &track : *tracks) {
        if (track["id"].toString() == from) fromTrack = track;
        if (track["id"].toString() == to) toTrack = track;
      }
      require(fromTrack.isObject(), "Unknown track ID");
      if (to.isEmpty()) {
        toTrack = newTrack("Track " + String(tracks->size() + 1));
        tracks->add(toTrack);
      }
      require(toTrack.isObject(), "Unknown track ID");
      auto *origin = fromTrack["clips"].getArray(), *destination = toTrack["clips"].getArray();
      require(origin && destination, "Invalid track clips");
      int index = 0;
      while (index < origin->size() && (*origin)[index]["id"].toString() != id) ++index;
      require(index < origin->size(), "Unknown clip ID");
      auto clip = copy((*origin)[index]);
      origin->remove(index);
      for (const auto &other : *destination)
        if (other["id"].toString() == id) { put(clip, "id", "clip_" + Uuid().toString().removeCharacters("-")); break; }
      put(clip, "start", nearestClipStart(*destination, number(request, "start", 0, 86400000), (double)clip["duration"]));
      destination->add(clip);
      put(fromTrack, "source", origin->isEmpty() ? Json() : (*origin)[0]["source"]);
      put(toTrack, "source", destination->isEmpty() ? Json() : (*destination)[0]["source"]);
      replace(p);
      return copy(session->project);
    }
    if (cmd == "set_graph_positions") {
      const auto id = string(request, "id");
      auto positions = request["positions"];
      require(positions.isObject(), "Graph positions must be object");
      Json target;
      if (id == "master")
        target = session->project["master"];
      else {
        for (auto &track : *session->project["tracks"].getArray())
          if (track["id"].toString() == id) { target = track; break; }
        require(target.isObject(), "Unknown track ID");
      }
      auto graph = target["graph"];
      std::set<String> ids{"@input", "@output"};
      for (const auto &node : *graph["chain"].getArray())
        ids.insert(node["id"].toString());
      for (const auto &mixer : *graph["routing"]["mixers"].getArray())
        ids.insert(mixer.toString());
      for (const auto &prop : positions.getDynamicObject()->getProperties()) {
        auto *point = prop.value.getArray();
        require(ids.count(prop.name.toString()) && point && point->size() == 2,
                "Invalid graph position");
        for (const auto &x : *point)
          require((x.isDouble() || x.isInt() || x.isInt64()) &&
                      std::isfinite((double)x) && std::abs((double)x) <= 1000000,
                  "Invalid graph coordinate");
      }
      {
        std::lock_guard<std::mutex> lock(mutex);
        auto routing = target["graph"]["routing"];
        put(routing, "positions", copy(positions));
      }
      return copy(session->project);
    }
    if (cmd == "set_track" || cmd == "set_master") {
      auto p = copy(session->project);
      const auto id = cmd == "set_master" ? String("master") : string(request, "id");
      Json target;
      if (cmd == "set_master")
        target = p["master"];
      else {
        for (auto &t : *p["tracks"].getArray())
          if (t["id"].toString() == id) {
            target = t;
            break;
          }
        require(target.isObject(), "Unknown track ID");
      }
      for (auto key : {"gainDb", "pan", "solo", "muted", "fxEnabled", "graph"})
        if (has(request, key))
          put(target, key, copy(request[key]));
      if (cmd == "set_track") {
        if (has(request, "label")) {
          auto label = string(request, "label").trim();
          require(label.isNotEmpty(), "Track name cannot be empty");
          put(target, "label", label);
          put(target, "customLabel", true);
        }
      }
      replace(p, false, has(request, "graph") ? id : String{});
      return copy(session->project);
    }
    if (cmd == "export")
      return exportFile(string(request, "path"));
    if (cmd == "export_track")
      return renderTrack(has(request, "project") ? request["project"]
                                                 : session->project,
                         string(request, "id"), {}, string(request, "path"),
                         false, has(request, "project"));
    if (cmd == "render_candidate")
      return renderTrack(request["project"], string(request, "trackId"),
                         request["graph"], string(request, "path"), true);
    if (cmd == "shutdown") {
      closeDevice();
      return true;
    }
    fail("Unknown engine command: " + cmd);
  }
};

void stage2SelfCheck(const File &input) {
  Engine engine;
  auto request = object();
  put(request, "command", "import");
  put(request, "paths",
      Array<var>{input.getFullPathName(), input.getFullPathName()});
  engine.handle(request);
  auto id = engine.session->tracks[0].data["id"].toString();
  auto project = copy(engine.session->project);
  auto track = (*project["tracks"].getArray())[0];
  put(track, "gainDb", -12);
  put(track, "pan", 1);
  put(track, "muted", true);
  put(track, "fxEnabled", false);
  put((*project["tracks"].getArray())[1], "solo", true);
  auto master = project["master"];
  put(master, "gainDb", -24);
  put(master, "muted", true);
  engine.replace(project);
  engine.position = 37;
  engine.playing = true;
  auto graph = JSON::parse(
      R"({"schema_version":3,"chain":[{"id":"boost","effect":"gain","enabled":true,"parameters":{"gain_db":20}}],"routing":{"mixers":[],"links":[{"source":"@input","target":"boost","gain_db":0},{"source":"boost","target":"@output","gain_db":0}],"positions":{}}})");
  auto delay = JSON::parse(
      R"({"schema_version":3,"chain":[{"id":"echo","effect":"delay","enabled":true,"parameters":{"delay_seconds":0.05,"feedback":0.4,"mix_ratio":0.5}}],"routing":{"mixers":[],"links":[{"source":"@input","target":"echo","gain_db":0},{"source":"echo","target":"@output","gain_db":0}],"positions":{}}})");
  int failures = 0;
  for (const auto &command :
       {String("render_candidate"), String("export_track")}) {
    try {
      TemporaryFile output(".wav");
      request = object();
      put(request, "command", command);
      put(request, "path", output.getFile().getFullPathName());
      if (command == "render_candidate") {
        put(project, "sampleRate", 48000);
        put(request, "project", project);
        put(request, "trackId", id);
        put(request, "graph", graph);
      } else {
        // Current FX and strip gain/pan are included even when audition muted.
        auto current = copy(engine.session->project);
        auto currentTrack = (*current["tracks"].getArray())[0];
        put(currentTrack, "fxEnabled", true);
        put(currentTrack, "graph", graph);
        engine.replace(current);
        put(request, "id", id);
      }
      const auto live = JSON::toString(engine.session->project, true);
      auto data = engine.handle(request);
      std::unique_ptr<AudioFormatReader> reader(
          engine.formats.createReaderFor(output.getFile()));
      const bool candidate = command == "render_candidate";
      require(reader && reader->sampleRate == (candidate ? 48000 : 44100) &&
                  reader->lengthInSamples == (candidate ? 4800 : 4410) &&
                  reader->bitsPerSample == (candidate ? 32 : 24) &&
                  reader->usesFloatingPointData == candidate,
              command + " WAV format/frame count failed");
      AudioBuffer<float> rendered(2, (int)reader->lengthInSamples);
      require(
          reader->read(&rendered, 0, rendered.getNumSamples(), 0, true, true),
          command + " decode failed");
      if (candidate) {
        require(
            rendered.getMagnitude(0, 0, rendered.getNumSamples()) > 1.99f &&
                rendered.getMagnitude(1, 0, rendered.getNumSamples()) > 1.99f &&
                (int64)data["frames"] == 4800 &&
                (double)data["sampleRate"] == 48000 &&
                std::abs((double)data["seconds"] - .1) < 1e-9 &&
                data["path"] == request["path"],
            "Candidate clipped overload or applied audition/master controls");
      } else {
        require(
            rendered.getMagnitude(0, 0, rendered.getNumSamples()) == 0 &&
                std::abs(rendered.getMagnitude(1, 0, rendered.getNumSamples()) -
                         .502377f) < .001,
            "Track export failed FX/gain/pan or included other "
            "tracks/master/solo/mute");
      }
      require(live == JSON::toString(engine.session->project, true) &&
                  engine.position == 37 && engine.playing,
              command + " changed live project/transport");
      reader.reset();
      const auto bytes = output.getFile().loadFileAsString();
      auto bad = copy(request);
      put(bad, candidate ? "trackId" : "id", "missing");
      bool rejected = false;
      try {
        engine.handle(bad);
      } catch (...) {
        rejected = true;
      }
      require(rejected && output.getFile().loadFileAsString() == bytes,
              command + " failure damaged existing destination");
      bad = copy(request);
      put(bad, "path", input.getFullPathName());
      rejected = false;
      try {
        engine.handle(bad);
      } catch (...) {
        rejected = true;
      }
      require(rejected, command + " overwrote source");
#if JUCE_WINDOWS
      auto lock = CreateFileW(
          output.getFile().getFullPathName().toWideCharPointer(), GENERIC_READ,
          FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
      require(lock != INVALID_HANDLE_VALUE,
              "Could not lock atomic destination fixture");
      rejected = false;
      try {
        engine.handle(request);
      } catch (...) {
        rejected = true;
      }
      CloseHandle(lock);
      require(rejected && output.getFile().loadFileAsString() == bytes,
              command + " atomic commit failure damaged destination");
#endif
      if (candidate) {
        put(request, "graph", delay);
        auto tail = engine.handle(request);
        require((int64)tail["frames"] == 100800, "Candidate fixed tail failed");
        // A fresh candidate graph must not advance the live delay state.
        Graph expected(delay, engine.plugins, 44100);
        auto active = std::make_shared<Graph>(delay, engine.plugins, 44100);
        engine.session->tracks[0].graph = active;
        AudioBuffer<float> a(2, blockSize), b(2, blockSize);
        a.clear();
        a.setSample(0, 0, .5f);
        b.makeCopyOf(a);
        active->process(a, blockSize);
        expected.process(b, blockSize);
        engine.handle(request);
        for (int block = 0; block < 6; ++block) {
          a.clear();
          b.clear();
          active->process(a, blockSize);
          expected.process(b, blockSize);
          for (int c = 0; c < 2; ++c)
            for (int i = 0; i < blockSize; ++i)
              require(a.getSample(c, i) == b.getSample(c, i),
                      "Candidate changed live DSP state");
        }
      }
    } catch (const std::exception &error) {
      ++failures;
      std::cerr << "FAIL " << command << ": " << error.what() << '\n';
    }
  }
  require(failures == 0, "Stage 2 offline commands failed");
  std::cerr
      << "PASS candidate float overload/rate/tail, live project/transport/DSP "
         "isolation, "
         "track FX/gain/pan isolation, atomic failures/source protection\n";
}

void liveEditingSelfCheck(const File &input) {
  Engine engine;
  auto request = JSON::parse(R"({"command":"import"})");
  put(request, "paths", Array<var>{input.getFullPathName(), input.getFullPathName()});
  const auto project = engine.handle(request);
  const auto id = project["tracks"][0]["id"];
  auto first = JSON::parse(R"({"command":"set_track","solo":true,"pan":1})");
  put(first, "id", id);
  engine.handle(first);
  engine.handle(JSON::parse(R"({"command":"set_master","gainDb":-12})"));
  auto committed = engine.handle(JSON::parse(R"({"command":"project"})"));

  // Drive the actual callback without opening an output device.
  engine.deviceOpen = true;
  auto play = JSON::parse(R"({"command":"play","position":37})");
  auto pause = JSON::parse(R"({"command":"pause"})");
  auto stop = JSON::parse(R"({"command":"stop"})");
  AudioBuffer<float> baseline(2, 2048), preview(2, 2048);
  auto capture = [&](AudioBuffer<float> &buffer) {
    engine.audioDeviceIOCallbackWithContext(
        nullptr, 0, buffer.getArrayOfWritePointers(), 2, buffer.getNumSamples(), {});
  };
  auto source = JSON::parse(R"({"command":"set_spectrum"})");
  put(source, "source", id);
  engine.handle(source);
  engine.handle(play);
  require(engine.playing && engine.position == 37, "Play ignored explicit cursor");
  capture(baseline);
  const auto progressed = engine.position;
  engine.handle(pause);
  require(!engine.playing && engine.position == progressed && progressed > 37,
          "Pause lost actual position");
  engine.handle(play);
  require(engine.position == 37, "Replay failed to restart at main cursor");

  auto draft = JSON::parse(
      R"({"command":"preview_graph","graph":{"schema_version":3,"chain":[{"id":"trim","effect":"gain","enabled":true,"parameters":{"gain_db":-20}}],"routing":{"mixers":[],"links":[{"source":"@input","target":"trim","gain_db":0},{"source":"trim","target":"@output","gain_db":0}],"positions":{}}}})");
  put(draft, "id", id);
  TemporaryFile exported(".wav");
  engine.exportFile(exported.getFile().getFullPathName());
  MemoryBlock originalWav, auditionWav;
  require(exported.getFile().loadFileAsData(originalWav), "Could not read export");
  engine.handle(draft);
  require(engine.playing && engine.position == 37, "Preview interrupted transport");
  auto invalid = copy(draft);
  put(invalid, "graph", object());
  bool rejected = false;
  try {
    engine.handle(invalid);
  } catch (const std::exception &) {
    rejected = true;
  }
  require(rejected, "Invalid preview was accepted");
  capture(preview);
  require(baseline.getMagnitude(1, 0, 2048) > 0 &&
              std::abs(preview.getMagnitude(1, 0, 2048) /
                           baseline.getMagnitude(1, 0, 2048) -
                       .1) < .0001,
          "Preview did not update playback or invalid preview replaced it");
  auto telemetry = engine.state();
  double selectedPeak = -100, masterPeak = -100;
  for (int i = 0; i < 1023; ++i) {
    selectedPeak = std::max(selectedPeak, (double)telemetry["spectrum"]["db"][i]);
    masterPeak = std::max(masterPeak, (double)telemetry["masterSpectrum"]["db"][i]);
  }
  require(std::abs(selectedPeak - masterPeak - 12) < .01,
          "Master spectrum did not follow post-mix gain while track was selected");
  engine.exportFile(exported.getFile().getFullPathName());
  require(exported.getFile().loadFileAsData(auditionWav) && auditionWav == originalWav &&
              JSON::toString(engine.handle(JSON::parse(R"({"command":"project"})")), true) ==
                  JSON::toString(committed, true),
          "Preview leaked into the project or export");
  auto clear = copy(draft);
  put(clear, "graph", {});
  engine.handle(clear);
  engine.handle(play);
  capture(preview);
  require(preview.getMagnitude(1, 0, 2048) == baseline.getMagnitude(1, 0, 2048),
          "Clearing preview failed to restore committed graph");

  engine.handle(draft);
  put(first, "graph", draft["graph"]);
  auto applied = engine.handle(first);
  require(!engine.session->tracks[0].preview.graph &&
              sameGraph(applied["tracks"][0]["graph"], draft["graph"]),
          "Track commit did not retire the preview");
  put(draft, "id", "master");
  engine.handle(draft);
  auto legacy = JSON::parse(R"({"command":"load_project"})");
  auto legacyMaster = committed["master"];
  put(legacyMaster, "solo", true);
  put(legacy, "project", committed);
  auto reopened = engine.handle(legacy);
  require(!engine.session->masterPreview.graph && boolean(reopened["master"], "solo") &&
              !engine.playing && engine.position == 0,
          "Load retained preview or lost master solo");
  engine.handle(play);
  capture(preview);
  require(preview.getMagnitude(0, 0, 2048) > 0 &&
              preview.getMagnitude(1, 0, 2048) > 0,
          "Master solo did not restore non-muted tracks");
  engine.handle(JSON::parse(R"({"command":"set_master","solo":false})"));
  engine.handle(play);
  capture(preview);
  require(preview.getMagnitude(0, 0, 2048) == 0 &&
              preview.getMagnitude(1, 0, 2048) > 0,
          "Master solo did not restore track solo filtering");
  engine.handle(stop);
  require(!engine.playing && engine.position == 0, "Stop did not reset transport");

  auto audition = JSON::parse(R"({"command":"play","position":37})");
  put(audition, "trackId", committed["tracks"][1]["id"]);
  engine.handle(audition);
  capture(preview);
  require(preview.getMagnitude(0, 0, 2048) > 0 && preview.getMagnitude(1, 0, 2048) > 0 &&
              engine.state()["playbackSource"] == committed["tracks"][1]["id"] &&
              boolean(engine.session->project["tracks"][0], "solo"),
          "Track audition did not isolate the requested track or changed solo state");
  engine.handle(play);
  capture(preview);
  require(preview.getMagnitude(0, 0, 2048) == 0 && preview.getMagnitude(1, 0, 2048) > 0 &&
              engine.state()["playbackSource"].toString() == "master",
          "Master playback did not restore track solo filtering");
  engine.handle(stop);

  engine.handle(JSON::parse(R"({"command":"set_master","gainDb":0})"));
  auto &samples = engine.session->tracks[0].source->audio;
  samples.clear();
  samples.setSample(1, 0, 1.25f);
  put(play, "position", 0);
  engine.handle(play);
  for (int i = 0; i < 4; ++i)
    capture(preview);
  const Identifier trackKey{id.toString()};
  const auto peak = engine.state();
  require(!engine.playing && (double)peak["master"][1] > 0 &&
              (double)peak["levels"][trackKey][1] > 0,
          "A short clip peak was lost before telemetry polled");
  const auto nextPeak = engine.state();
  require((double)nextPeak["master"][1] == -100 &&
              (double)nextPeak["levels"][trackKey][1] == -100,
          "Old clip peak was repeated without new audio");
}

void loopSelfCheck(const File &input) {
  Engine engine;
  auto import = JSON::parse(R"({"command":"import"})");
  put(import, "paths", Array<var>{input.getFullPathName()});
  engine.handle(import);
  engine.deviceOpen = true;
  auto loop = JSON::parse(R"({"command":"set_loop","start":20,"end":80,"enabled":true})");
  const auto saved = engine.handle(loop);
  require(boolean(saved["loop"], "enabled"), "Loop selection was not saved in project");
  engine.handle(JSON::parse(R"({"command":"play","position":20})"));
  AudioBuffer<float> output(2, 5000);
  engine.audioDeviceIOCallbackWithContext(nullptr, 0, output.getArrayOfWritePointers(), 2, 5000, {});
  const auto &source = engine.session->tracks[0].source->audio;
  for (int i = 0; i < output.getNumSamples(); ++i)
    require(std::abs(output.getSample(0, i) - source.getSample(0, 882 + i % 2646)) < .0001f,
            "Loop boundary did not repeat the selected samples");
  require(engine.playing && engine.position >= 20 && engine.position < 80,
          "Loop transport did not remain inside the selection");
  TemporaryFile exported(".wav");
  engine.exportFile(exported.getFile().getFullPathName());
  std::unique_ptr<AudioFormatReader> reader(engine.formats.createReaderFor(exported.getFile()));
  require(reader && reader->lengthInSamples == 4410, "Loop changed full mix export length");
  engine.handle(JSON::parse(R"({"command":"set_loop","start":20,"end":80,"enabled":false})"));
  auto reload = JSON::parse(R"({"command":"load_project"})");
  put(reload, "project", saved);
  engine.handle(reload);
  require(engine.loopEnabled && engine.loopStart == 20 && engine.loopEnd == 80,
          "Loop selection did not restore with the project");
  engine.handle(JSON::parse(R"({"command":"set_loop","start":20,"end":80,"enabled":false})"));
  engine.handle(JSON::parse(R"({"command":"play","position":80})"));
  engine.audioDeviceIOCallbackWithContext(nullptr, 0, output.getArrayOfWritePointers(), 2, 5000, {});
  require(!engine.playing && engine.position == engine.session->duration,
          "Disabled loop did not play to the end");
}

void selfCheck() {
  Engine engine;
  TemporaryFile input(".wav");
  WavAudioFormat wav;
  auto stream = input.getFile().createOutputStream();
  require(stream != nullptr, "Fixture stream failed");
  std::unique_ptr<AudioFormatWriter> writer(
      wav.createWriterFor(stream.get(), 44100, 2, 24, {}, 0));
  require(writer != nullptr, "Fixture writer failed");
  stream.release();
  AudioBuffer<float> signal(2, 4410);
  for (int c = 0; c < 2; ++c)
    for (int i = 0; i < 4410; ++i)
      signal.setSample(
          c, i,
          .2f * std::sin(MathConstants<double>::twoPi * 1000 * i / 44100.0));
  require(writer->writeFromAudioSampleBuffer(signal, 0, 4410),
          "Fixture write failed");
  writer.reset();
  auto request = object();
  put(request, "command", "import");
  put(request, "paths", Array<var>{input.getFile().getFullPathName()});
  engine.handle(request);
  require(engine.session->tracks.size() == 1 && engine.session->duration > 99.9,
          "Import metadata failed");
  AudioBuffer<float> baseline(2, blockSize), processed(2, blockSize);
  engine.session->render(baseline, blockSize, 0, "master");
  float initial = baseline.getMagnitude(0, 0, blockSize);
  auto graph = JSON::parse(
      R"({"schema_version":3,"chain":[{"id":"fx_gain","effect":"gain","enabled":true,"parameters":{"gain_db":-6}}],"routing":{"mixers":[],"links":[{"source":"@input","target":"fx_gain","gain_db":0},{"source":"fx_gain","target":"@output","gain_db":0}],"positions":{}}})");
  auto id = engine.session->tracks[0].data["id"].toString();
  request = object();
  put(request, "command", "set_track");
  put(request, "id", id);
  put(request, "graph", graph);
  engine.handle(request);
  engine.session->render(processed, blockSize, 0, "master");
  require(std::abs(processed.getMagnitude(0, 0, blockSize) / initial -
                   gain(-6)) < .0001,
          "Track graph gain failed");
  request = object();
  put(request, "command", "set_master");
  put(request, "graph", graph);
  put(request, "gainDb", -6);
  engine.handle(request);
  engine.session->render(processed, blockSize, 0, "master");
  require(std::abs(processed.getMagnitude(0, 0, blockSize) / initial -
                   gain(-18)) < .0001,
          "Master graph/bus gain failed");
  auto before = JSON::toString(engine.session->project, true);
  request = object();
  put(request, "command", "set_track");
  put(request, "id", id);
  put(request, "pan", 2);
  bool rejected = false;
  try {
    engine.handle(request);
  } catch (...) {
    rejected = true;
  }
  require(rejected && before == JSON::toString(engine.session->project, true),
          "Failed edit was not atomic");
  auto branched = JSON::parse(
      R"({"schema_version":3,"chain":[],"routing":{"mixers":["mix_a","mix_b"],"links":[{"source":"@input","target":"mix_a","gain_db":0},{"source":"@input","target":"mix_b","gain_db":0},{"source":"mix_a","target":"mix_b","gain_db":-6},{"source":"mix_b","target":"@output","gain_db":0}],"positions":{}}})");
  // Invalid single-input mixer is rejected before it can affect playback.
  rejected = false;
  try {
    Graph bad(branched, engine.plugins, 44100);
  } catch (...) {
    rejected = true;
  }
  require(rejected, "Invalid mixer accepted");
  auto parallel = JSON::parse(
      R"({"schema_version":3,"chain":[{"id":"a","effect":"gain","enabled":true,"parameters":{"gain_db":-6}},{"id":"b","effect":"gain","enabled":true,"parameters":{"gain_db":-6}}],"routing":{"mixers":["sum"],"links":[{"source":"@input","target":"a","gain_db":0},{"source":"@input","target":"b","gain_db":0},{"source":"a","target":"sum","gain_db":0},{"source":"b","target":"sum","gain_db":-6},{"source":"sum","target":"@output","gain_db":0}],"positions":{}}})");
  Graph parallelGraph(parallel, engine.plugins, 44100);
  processed.makeCopyOf(baseline);
  parallelGraph.process(processed, blockSize);
  require(std::abs(processed.getMagnitude(0, 0, blockSize) / initial -
                   (gain(-6) + gain(-12))) < .0001,
          "Parallel mixer gain failed");
  // Exercise every advertised built-in at a real sample rate and a partial
  // block.
  for (const auto &[kind, ranges] : catalog()) {
    auto node = object(), params = object();
    put(node, "id", "check");
    put(node, "effect", kind);
    put(node, "enabled", true);
    for (const auto &[key, bounds] : ranges)
      put(params, key, (bounds.first + bounds.second) * .5);
    put(node, "parameters", params);
    Effect effect(node, engine.plugins, 44100);
    processed.makeCopyOf(baseline);
    effect.process(processed, 127);
    for (int c = 0; c < 2; ++c)
      for (int i = 0; i < 127; ++i)
        require(std::isfinite(processed.getSample(c, i)),
                "Built-in produced non-finite audio: " + kind);
  }
  TemporaryFile exported(".wav");
  engine.exportFile(exported.getFile().getFullPathName());
  std::unique_ptr<AudioFormatReader> reader(
      engine.formats.createReaderFor(exported.getFile()));
  require(reader && reader->lengthInSamples == 4410,
          "Export sample count failed");
  AudioBuffer<float> result(2, 4410);
  require(reader->read(&result, 0, 4410, 0, true, true),
          "Export decoding failed");
  require(std::abs(result.getMagnitude(0, 0, 4410) / initial - gain(-18)) <
              .001,
          "Export differs from playback DSP");
  request = object();
  put(request, "command", "set_track");
  put(request, "id", id);
  put(request, "muted", true);
  engine.handle(request);
  engine.session->render(processed, blockSize, 0, "master");
  require(processed.getMagnitude(0, 0, blockSize) == 0, "Mute failed");
  // Import a second synchronized source and prove solo filtering and panning.
  request = object();
  put(request, "command", "import");
  put(request, "paths", Array<var>{input.getFile().getFullPathName()});
  engine.handle(request);
  auto second = engine.session->tracks[1].data["id"].toString();
  request = object();
  put(request, "command", "set_track");
  put(request, "id", second);
  put(request, "solo", true);
  put(request, "pan", 1);
  engine.handle(request);
  engine.session->render(processed, blockSize, 0, "master");
  require(processed.getMagnitude(0, 0, blockSize) == 0 &&
              processed.getMagnitude(1, 0, blockSize) > 0,
          "Solo/pan failed");
  engine.output.makeCopyOf(baseline);
  engine.selected.makeCopyOf(baseline);
  engine.selected.applyGain(1, 0, blockSize, -1);
  for (int i = 0; i < 4; ++i)
    engine.capture(blockSize);
  auto telemetry = engine.state();
  require(telemetry["spectrum"]["db"].size() == 1023, "Spectrum failed");
  double strongest = -100;
  for (const auto &x : *telemetry["spectrum"]["db"].getArray())
    strongest = std::max(strongest, (double)x);
  require(strongest > -30, "Antiphase stereo disappeared from spectrum");
  auto missing = copy(engine.session->project);
  put((*missing["tracks"].getArray())[0], "source",
      input.getFile()
          .getSiblingFile("missing-audio-file.wav")
          .getFullPathName());
  before = JSON::toString(engine.session->project, true);
  rejected = false;
  try {
    engine.replace(missing);
  } catch (...) {
    rejected = true;
  }
  require(rejected && before == JSON::toString(engine.session->project, true),
          "Failed project load was not atomic");
  Engine tails;
  request = object();
  put(request, "command", "import");
  put(request, "paths", Array<var>{input.getFile().getFullPathName()});
  tails.handle(request);
  auto delayGraph = JSON::parse(
      R"({"schema_version":3,"chain":[{"id":"echo","effect":"delay","enabled":true,"parameters":{"delay_seconds":0.05,"feedback":0.4,"mix_ratio":0.5}}],"routing":{"mixers":[],"links":[{"source":"@input","target":"echo","gain_db":0},{"source":"echo","target":"@output","gain_db":0}],"positions":{}}})");
  request = object();
  put(request, "command", "set_track");
  put(request, "id", tails.session->tracks[0].data["id"]);
  put(request, "graph", delayGraph);
  tails.handle(request);
  request = object();
  put(request, "command", "set_master");
  put(request, "graph", delayGraph);
  tails.handle(request);
  require(std::abs(tails.session->duration - 4100) < .001 &&
              std::abs((double)tails.session->tracks[0].data["duration"] -
                       2100) < .001,
          "Track/master tail duration failed");
  TemporaryFile tailExport(".wav");
  tails.exportFile(tailExport.getFile().getFullPathName());
  std::unique_ptr<AudioFormatReader> tailReader(
      tails.formats.createReaderFor(tailExport.getFile()));
  require(tailReader && tailReader->lengthInSamples == 180810,
          "Tail export frame count failed");
  AudioBuffer<float> tailAudio(2, 1024);
  require(tailReader->read(&tailAudio, 0, 1024, 5000, true, true) &&
              tailAudio.getMagnitude(0, 0, 1024) > 0,
          "Zero-input tail processing failed");
  stage2SelfCheck(input.getFile());
  liveEditingSelfCheck(input.getFile());
  loopSelfCheck(input.getFile());
  Engine pitched;
  auto importPitchFixture = object();
  put(importPitchFixture, "command", "import");
  put(importPitchFixture, "paths",
      Array<var>{input.getFile().getFullPathName()});
  pitched.handle(importPitchFixture);
  auto shift = JSON::parse(R"({
    "schema_version":3,
    "chain":[
      {"id":"dry","effect":"panner","enabled":true,"parameters":{"pan":-1}},
      {"id":"pitch","effect":"pitch_shift","enabled":true,"parameters":{"semitones":12}},
      {"id":"wet","effect":"panner","enabled":true,"parameters":{"pan":1}}
    ],
    "routing":{"mixers":["sum"],"positions":{},"links":[
      {"source":"@input","target":"dry","gain_db":0},
      {"source":"@input","target":"pitch","gain_db":0},
      {"source":"pitch","target":"wet","gain_db":0},
      {"source":"dry","target":"sum","gain_db":0},
      {"source":"wet","target":"sum","gain_db":0},
      {"source":"sum","target":"@output","gain_db":0}
    ]}
  })");
  auto setPitch = object();
  put(setPitch, "command", "set_track");
  put(setPitch, "id", pitched.session->tracks[0].data["id"]);
  put(setPitch, "graph", shift);
  pitched.handle(setPitch);
  const int frames = signal.getNumSamples();
  AudioBuffer<float> playback(2, frames), exportedPitch(2, frames);
  pitched.session->prime(0);
  pitched.playing = true;
  pitched.audioDeviceIOCallbackWithContext(
      nullptr, 0, playback.getArrayOfWritePointers(), 2, frames, {});
  TemporaryFile pitchExport(".wav");
  pitched.exportFile(pitchExport.getFile().getFullPathName());
  std::unique_ptr<AudioFormatReader> pitchReader(
      pitched.formats.createReaderFor(pitchExport.getFile()));
  require(pitchReader && pitchReader->lengthInSamples == frames &&
              pitchReader->read(&exportedPitch, 0, frames, 0, true, true),
          "Pitch export frame count failed");
  for (int c = 0; c < 2; ++c)
    for (int i = 0; i < frames; ++i)
      require(std::abs(exportedPitch.getSample(c, i) -
                       playback.getSample(c, i)) < .00001,
              "Pitch playback/export mismatch");
  pitched.handle(JSON::parse(R"({"command":"seek","position":40})"));
  pitched.playing = true;
  pitched.session->prime(40);
  pitched.audioDeviceIOCallbackWithContext(
      nullptr, 0, playback.getArrayOfWritePointers(), 2, 256, {});
  for (int i = 0; i < 256; ++i)
    require(std::abs(playback.getSample(0, i) -
                     exportedPitch.getSample(0, 1764 + i)) < .00001,
            "Pitch dry branch misaligned after seek");
  std::cerr
      << "PASS import/waveform, track/master DAG, parallel mixer, all "
      << catalog().size()
      << " built-ins, pitch callback/export parity and seek, "
         "atomic edit/load validation, export parity, "
         "mute/solo/pan, FFT, track/master tails; no audio device opened\n";
}
} // namespace

int main(int argc, char **argv) {
  try {
    ProtocolOutput protocol;
    ScopedJuceInitialiser_GUI juce;
    if (argc > 1 && String(argv[1]) == "--self-test") {
      selfCheck();
      auto response = object();
      put(response, "ok", true);
      put(response, "data", "offline self-check passed");
      protocol.write(response);
      return 0;
    }
    Engine engine;
    std::string line;
    while (std::getline(std::cin, line)) {
      auto response = object();
      bool shutdown = false;
      try {
        Json request;
        auto parse = JSON::parse(
            String::fromUTF8(line.data(), (int)line.size()), request);
        require(parse.wasOk(), "Invalid JSON: " + parse.getErrorMessage());
        auto data = engine.handle(request);
        shutdown = request["command"].toString() == "shutdown";
        put(response, "ok", true);
        put(response, "data", data);
      } catch (const std::exception &error) {
        put(response, "ok", false);
        put(response, "error", String::fromUTF8(error.what()));
      }
      protocol.write(response);
      if (shutdown)
        break;
    }
  } catch (const std::exception &error) {
    std::cerr << error.what() << std::endl;
    return 1;
  }
  return 0;
}
