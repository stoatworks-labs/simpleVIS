#!/usr/bin/env python3
"""Author the example rig that ships with simpleVIS.

**Why this exists rather than shipping a real MVR.** The file everything is
tested against is MA Lighting's `Demostage_MVR.mvr`, which is MA's content: it
cannot be committed to a public repo, published in a hosted build, or filmed for
a video. So this writes an MVR and a GDTF from scratch — every byte authored
here, owned by this project, safe to ship anywhere.

It buys three things at once:

  - the hosted build has something to show on first load, instead of an empty
    stage and a file picker;
  - CI can run the full test suite, where the Demostage-backed suites otherwise
    skip;
  - the project video has footage that is legally ours.

**It is not a substitute for testing against real files.** A file written by
this script tests this script's idea of the formats, which is the same idea the
parser has — the two would agree on a shared misreading. The Demostage suites
remain the authority on what real exports look like; this is a fixture, not a
reference.

    python3 scripts/make-example-rig.py

Writes `packages/app/public/example-rig.mvr`.
"""
from __future__ import annotations

import math
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "packages/app/public/example-rig.mvr"

GDTF_NAME = "Stoatworks@Example Spot"


def gdtf_description() -> str:
    """A moving head: Base -> Yoke -> Head -> Beam, 12 DMX channels.

    Deliberately exercises the awkward parts of GDTF rather than the easy ones,
    so the example rig is a real test of the importer:

      - **Pan and Tilt run backwards** (`270 -> -270`), as every real fixture's
        do, and are 16-bit.
      - **Pan is written against the Yoke and Tilt against the Head**, so the
        articulation has to come from the file rather than a hard-coded
        moving-head skeleton.
      - **Zoom is inverted too** (`45 -> 8` degrees), so a rising DMX value
        narrows the beam.
      - **Shutter has a closed band at 0**, so a rig with nothing patched
        renders dark rather than blazing.
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="Example Spot" ShortName="ExSpot" LongName="Stoatworks Example Spot"
               Manufacturer="Stoatworks" Description="Example moving head for simpleVIS"
               FixtureTypeID="7C9E1C5A-1111-4A2B-9E3D-000000000001" RefFT="">
    <AttributeDefinitions>
      <ActivationGroups>
        <ActivationGroup Name="PanTilt"/>
        <ActivationGroup Name="ColorRGB"/>
      </ActivationGroups>
      <FeatureGroups>
        <FeatureGroup Name="Position" Pretty="P"><Feature Name="PanTilt"/></FeatureGroup>
        <FeatureGroup Name="Dimmer" Pretty="D"><Feature Name="Dimmer"/></FeatureGroup>
        <FeatureGroup Name="Color" Pretty="C"><Feature Name="RGB"/></FeatureGroup>
        <FeatureGroup Name="Beam" Pretty="B"><Feature Name="Beam"/></FeatureGroup>
        <FeatureGroup Name="Control" Pretty="Ctrl"><Feature Name="Control"/></FeatureGroup>
      </FeatureGroups>
      <Attributes>
        <Attribute Name="Pan" Pretty="P" ActivationGroup="PanTilt" Feature="Position.PanTilt" PhysicalUnit="Angle"/>
        <Attribute Name="Tilt" Pretty="T" ActivationGroup="PanTilt" Feature="Position.PanTilt" PhysicalUnit="Angle"/>
        <Attribute Name="Dimmer" Pretty="Dim" Feature="Dimmer.Dimmer" PhysicalUnit="LuminousIntensity"/>
        <Attribute Name="Shutter1" Pretty="Sh1" Feature="Control.Control"/>
        <Attribute Name="Shutter1Strobe" Pretty="Strobe" Feature="Control.Control" PhysicalUnit="Frequency"/>
        <Attribute Name="ColorAdd_R" Pretty="R" ActivationGroup="ColorRGB" Feature="Color.RGB"/>
        <Attribute Name="ColorAdd_G" Pretty="G" ActivationGroup="ColorRGB" Feature="Color.RGB"/>
        <Attribute Name="ColorAdd_B" Pretty="B" ActivationGroup="ColorRGB" Feature="Color.RGB"/>
        <Attribute Name="Zoom" Pretty="Zoom" Feature="Beam.Beam" PhysicalUnit="Angle"/>
      </Attributes>
    </AttributeDefinitions>
    <Wheels/>
    <PhysicalDescriptions/>
    <Models>
      <Model Name="Base" Length="0.32" Width="0.26" Height="0.10" PrimitiveType="Undefined" File=""/>
      <Model Name="Yoke" Length="0.30" Width="0.12" Height="0.34" PrimitiveType="Undefined" File=""/>
      <Model Name="Head" Length="0.24" Width="0.22" Height="0.36" PrimitiveType="Undefined" File=""/>
      <Model Name="Beam" Length="0.14" Width="0.14" Height="0.01" PrimitiveType="Cylinder" File=""/>
    </Models>
    <Geometries>
      <Geometry Name="Base" Model="Base"
                Position="{{1.000000,0.000000,0.000000,0.000000}}{{0.000000,1.000000,0.000000,0.000000}}{{0.000000,0.000000,1.000000,0.000000}}{{0,0,0,1}}">
        <Axis Name="Yoke" Model="Yoke"
              Position="{{1.000000,0.000000,0.000000,0.000000}}{{0.000000,1.000000,0.000000,0.000000}}{{0.000000,0.000000,1.000000,-0.110000}}{{0,0,0,1}}">
          <Axis Name="Head" Model="Head"
                Position="{{1.000000,0.000000,0.000000,0.000000}}{{0.000000,1.000000,0.000000,0.000000}}{{0.000000,0.000000,1.000000,-0.260000}}{{0,0,0,1}}">
            <Beam Name="Beam" Model="Beam" LampType="LED" BeamAngle="18.000000" FieldAngle="22.000000"
                  BeamRadius="0.070000" BeamType="Spot" ColorTemperature="6500.000000"
                  LuminousFlux="18000.000000" PowerConsumption="450.000000"
                  Position="{{1.000000,0.000000,0.000000,0.000000}}{{0.000000,1.000000,0.000000,0.000000}}{{0.000000,0.000000,1.000000,-0.190000}}{{0,0,0,1}}"/>
          </Axis>
        </Axis>
      </Geometry>
    </Geometries>
    <DMXModes>
      <DMXMode Name="Standard" Geometry="Base">
        <DMXChannels>
          <DMXChannel DMXBreak="1" Offset="1,2" Highlight="None" Geometry="Yoke">
            <LogicalChannel Attribute="Pan" Snap="No" Master="None">
              <ChannelFunction Name="Pan" Attribute="Pan" DMXFrom="0/2" Default="32768/2"
                               PhysicalFrom="270.000000" PhysicalTo="-270.000000"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="3,4" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="Tilt" Snap="No" Master="None">
              <ChannelFunction Name="Tilt" Attribute="Tilt" DMXFrom="0/2" Default="32768/2"
                               PhysicalFrom="130.000000" PhysicalTo="-130.000000"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="5" Highlight="255/1" Geometry="Head">
            <LogicalChannel Attribute="Dimmer" Snap="No" Master="Grand">
              <ChannelFunction Name="Dimmer" Attribute="Dimmer" DMXFrom="0/1" Default="0/1"
                               PhysicalFrom="0.000000" PhysicalTo="1.000000"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="6" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="Shutter1" Snap="Yes" Master="None">
              <ChannelFunction Name="Closed" Attribute="Shutter1" DMXFrom="0/1" Default="0/1"
                               PhysicalFrom="0.000000" PhysicalTo="0.000000"/>
              <ChannelFunction Name="Open" Attribute="Shutter1" DMXFrom="32/1" Default="32/1"
                               PhysicalFrom="1.000000" PhysicalTo="1.000000"/>
              <ChannelFunction Name="Strobe" Attribute="Shutter1Strobe" DMXFrom="160/1" Default="160/1"
                               PhysicalFrom="1.000000" PhysicalTo="20.000000"/>
              <ChannelFunction Name="Open 2" Attribute="Shutter1" DMXFrom="240/1" Default="240/1"
                               PhysicalFrom="1.000000" PhysicalTo="1.000000"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="7" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="ColorAdd_R" Snap="No" Master="None">
              <ChannelFunction Name="Red" Attribute="ColorAdd_R" DMXFrom="0/1" Default="255/1"
                               PhysicalFrom="0.000000" PhysicalTo="1.000000"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="8" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="ColorAdd_G" Snap="No" Master="None">
              <ChannelFunction Name="Green" Attribute="ColorAdd_G" DMXFrom="0/1" Default="255/1"
                               PhysicalFrom="0.000000" PhysicalTo="1.000000"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="9" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="ColorAdd_B" Snap="No" Master="None">
              <ChannelFunction Name="Blue" Attribute="ColorAdd_B" DMXFrom="0/1" Default="255/1"
                               PhysicalFrom="0.000000" PhysicalTo="1.000000"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="10" Highlight="None" Geometry="Head">
            <LogicalChannel Attribute="Zoom" Snap="No" Master="None">
              <ChannelFunction Name="Zoom" Attribute="Zoom" DMXFrom="0/1" Default="128/1"
                               PhysicalFrom="45.000000" PhysicalTo="8.000000"/>
            </LogicalChannel>
          </DMXChannel>
        </DMXChannels>
        <Relations/>
        <FTMacros/>
      </DMXMode>
    </DMXModes>
    <Revisions/>
  </FixtureType>
</GDTF>
"""


def mvr_matrix(x_mm: float, y_mm: float, z_mm: float) -> str:
    """MVR `<Matrix>`: `{u}{v}{w}{origin}`, identity basis, origin in MILLIMETRES."""
    return (
        "{1.000000,0.000000,0.000000}"
        "{0.000000,1.000000,0.000000}"
        "{0.000000,0.000000,1.000000}"
        f"{{{x_mm:.6f},{y_mm:.6f},{z_mm:.6f}}}"
    )


def scene_description() -> str:
    """A 24-fixture rig on two trusses, patched across two universes.

    Positions are in millimetres because that is what MVR uses, while the GDTF
    beside it is in metres — the mismatch this project's importer exists to get
    right, so the example rig should exercise it rather than dodge it.
    """
    layer_uuid = "1D1F1F00-0000-4000-8000-000000000001"
    class_uuid = "1D1F1F00-0000-4000-8000-0000000000C1"

    fixtures: list[str] = []
    index = 0

    # Two trusses: an upstage one at 8 m and a downstage one at 7 m, 10 fixtures
    # each, plus four floor units.
    rows = [
        ("Upstage", 8000.0, 4200.0, 10),
        ("Downstage", 7000.0, -1200.0, 10),
    ]
    for row_name, height_mm, depth_mm, count in rows:
        span = 11000.0
        for i in range(count):
            x = -span / 2 + span * i / (count - 1)
            index += 1
            address = index * 10 - 9  # 10-channel footprint, packed from slot 1
            fixtures.append(fixture_xml(
                name=f"{row_name} {i + 1}",
                uuid=f"1D1F1F00-0000-4000-8001-{index:012d}",
                matrix=mvr_matrix(x, depth_mm, height_mm),
                address=address,
                fixture_id=index,
                class_uuid=class_uuid,
            ))

    for i in range(4):
        x = -4500.0 + 3000.0 * i
        index += 1
        address = index * 10 - 9
        fixtures.append(fixture_xml(
            name=f"Floor {i + 1}",
            uuid=f"1D1F1F00-0000-4000-8001-{index:012d}",
            matrix=mvr_matrix(x, -4200.0, 300.0),
            address=address,
            fixture_id=index,
            class_uuid=class_uuid,
        ))

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="5">
  <UserData/>
  <Scene>
    <AUXData>
      <Class uuid="{class_uuid}" name="Example rig"/>
    </AUXData>
    <Layers>
      <Layer uuid="{layer_uuid}" name="Example rig">
        <ChildList>
{"".join(fixtures)}        </ChildList>
      </Layer>
    </Layers>
  </Scene>
</GeneralSceneDescription>
"""


def fixture_xml(name: str, uuid: str, matrix: str, address: int,
                fixture_id: int, class_uuid: str) -> str:
    return f"""          <Fixture uuid="{uuid}" name="{escape(name)}">
            <Matrix>{matrix}</Matrix>
            <Classing>{class_uuid}</Classing>
            <GDTFSpec>{escape(GDTF_NAME)}</GDTFSpec>
            <GDTFMode>Standard</GDTFMode>
            <Addresses>
              <Address break="0">{address}</Address>
            </Addresses>
            <FixtureID>{fixture_id}</FixtureID>
            <UnitNumber>0</UnitNumber>
            <FixtureTypeId>0</FixtureTypeId>
            <CustomId>0</CustomId>
            <Color>0.312712,0.329008,100.000000</Color>
            <CastShadow>false</CastShadow>
            <Mappings/>
          </Fixture>
"""


def main() -> int:
    gdtf_bytes = _zip_bytes({"description.xml": gdtf_description().encode("utf-8")})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("GeneralSceneDescription.xml", scene_description())
        archive.writestr(f"{GDTF_NAME}.gdtf", gdtf_bytes)

    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


def _zip_bytes(entries: dict[str, bytes]) -> bytes:
    import io

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


if __name__ == "__main__":
    raise SystemExit(main())
