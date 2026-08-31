use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use wasm_bindgen::prelude::*;

const EPS: f64 = 0.001;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wall {
    pub id: String,
    pub start: Point,
    pub end: Point,
    pub thickness_mm: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opening {
    pub id: String,
    pub wall_id: String,
    pub kind: String,
    pub offset_mm: i32,
    pub width_mm: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMarker {
    pub id: String,
    pub name: String,
    pub position: Point,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Furniture {
    pub id: String,
    pub position: Point,
    pub width_mm: i32,
    pub depth_mm: i32,
    #[serde(default)]
    pub rotation_degrees: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloorInput {
    pub walls: Vec<Wall>,
    #[serde(default)]
    pub openings: Vec<Opening>,
    #[serde(default)]
    pub room_markers: Vec<RoomMarker>,
    #[serde(default)]
    pub furniture: Vec<Furniture>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedRoom {
    pub id: String,
    pub name: String,
    pub polygon: Vec<Point>,
    pub area_square_metres: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub severity: String,
    pub entity_id: Option<String>,
    pub message: String,
}

fn parse_floor(json: &str) -> Result<FloorInput, String> {
    serde_json::from_str(json).map_err(|error| format!("Invalid floor JSON: {error}"))
}

fn length(a: Point, b: Point) -> f64 {
    let dx = f64::from(b.x - a.x);
    let dy = f64::from(b.y - a.y);
    (dx * dx + dy * dy).sqrt()
}

fn cross(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    ax * by - ay * bx
}

fn segment_intersection(a: Point, b: Point, c: Point, d: Point) -> Option<Point> {
    let rx = f64::from(b.x - a.x);
    let ry = f64::from(b.y - a.y);
    let sx = f64::from(d.x - c.x);
    let sy = f64::from(d.y - c.y);
    let denominator = cross(rx, ry, sx, sy);
    if denominator.abs() < EPS {
        return None;
    }
    let qpx = f64::from(c.x - a.x);
    let qpy = f64::from(c.y - a.y);
    let t = cross(qpx, qpy, sx, sy) / denominator;
    let u = cross(qpx, qpy, rx, ry) / denominator;
    if (-EPS..=1.0 + EPS).contains(&t) && (-EPS..=1.0 + EPS).contains(&u) {
        Some(Point {
            x: (f64::from(a.x) + t * rx).round() as i32,
            y: (f64::from(a.y) + t * ry).round() as i32,
        })
    } else {
        None
    }
}

fn point_on_segment(point: Point, a: Point, b: Point) -> bool {
    let abx = f64::from(b.x - a.x);
    let aby = f64::from(b.y - a.y);
    let apx = f64::from(point.x - a.x);
    let apy = f64::from(point.y - a.y);
    cross(abx, aby, apx, apy).abs() < 0.5
        && point.x >= a.x.min(b.x)
        && point.x <= a.x.max(b.x)
        && point.y >= a.y.min(b.y)
        && point.y <= a.y.max(b.y)
}

fn signed_area(polygon: &[Point]) -> f64 {
    polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .take(polygon.len())
        .map(|(a, b)| f64::from(a.x) * f64::from(b.y) - f64::from(b.x) * f64::from(a.y))
        .sum::<f64>()
        / 2.0
}

fn contains(polygon: &[Point], point: Point) -> bool {
    let mut inside = false;
    for (a, b) in polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .take(polygon.len())
    {
        if point_on_segment(point, *a, *b) {
            return true;
        }
        let crosses = (a.y > point.y) != (b.y > point.y)
            && f64::from(point.x)
                < f64::from(b.x - a.x) * f64::from(point.y - a.y) / f64::from(b.y - a.y)
                    + f64::from(a.x);
        if crosses {
            inside = !inside;
        }
    }
    inside
}

fn triangle_contains(a: Point, b: Point, c: Point, point: Point) -> bool {
    let side = |p1: Point, p2: Point, p: Point| cross(f64::from(p2.x - p1.x), f64::from(p2.y - p1.y), f64::from(p.x - p1.x), f64::from(p.y - p1.y));
    side(a, b, point) >= -EPS && side(b, c, point) >= -EPS && side(c, a, point) >= -EPS
}

fn triangulate(polygon: &[Point]) -> Vec<[Point; 3]> {
    if polygon.len() < 3 { return Vec::new(); }
    let mut indices: Vec<usize> = (0..polygon.len()).collect();
    if signed_area(polygon) < 0.0 { indices.reverse(); }
    let mut triangles = Vec::with_capacity(polygon.len() - 2);
    while indices.len() > 3 {
        let mut ear = None;
        for cursor in 0..indices.len() {
            let previous = indices[(cursor + indices.len() - 1) % indices.len()];
            let current = indices[cursor];
            let next = indices[(cursor + 1) % indices.len()];
            let a = polygon[previous]; let b = polygon[current]; let c = polygon[next];
            if cross(f64::from(b.x - a.x), f64::from(b.y - a.y), f64::from(c.x - b.x), f64::from(c.y - b.y)) <= EPS { continue; }
            if indices.iter().copied().filter(|index| *index != previous && *index != current && *index != next).any(|index| triangle_contains(a, b, c, polygon[index])) { continue; }
            ear = Some((cursor, [a, b, c])); break;
        }
        let Some((cursor, triangle)) = ear else { return Vec::new() };
        triangles.push(triangle); indices.remove(cursor);
    }
    triangles.push([polygon[indices[0]], polygon[indices[1]], polygon[indices[2]]]);
    triangles
}

fn split_graph(walls: &[Wall]) -> BTreeMap<Point, Vec<Point>> {
    let mut wall_points: Vec<BTreeSet<Point>> = walls
        .iter()
        .map(|wall| BTreeSet::from([wall.start, wall.end]))
        .collect();
    for left in 0..walls.len() {
        for right in left + 1..walls.len() {
            if let Some(point) = segment_intersection(
                walls[left].start,
                walls[left].end,
                walls[right].start,
                walls[right].end,
            ) {
                wall_points[left].insert(point);
                wall_points[right].insert(point);
            } else {
                for point in [walls[left].start, walls[left].end] {
                    if point_on_segment(point, walls[right].start, walls[right].end) { wall_points[right].insert(point); }
                }
                for point in [walls[right].start, walls[right].end] {
                    if point_on_segment(point, walls[left].start, walls[left].end) { wall_points[left].insert(point); }
                }
            }
        }
    }
    let mut graph: BTreeMap<Point, Vec<Point>> = BTreeMap::new();
    for (wall, points) in walls.iter().zip(wall_points.iter()) {
        let mut ordered: Vec<Point> = points.iter().copied().collect();
        ordered.sort_by(|a, b| {
            let da = f64::from(a.x - wall.start.x).powi(2) + f64::from(a.y - wall.start.y).powi(2);
            let db = f64::from(b.x - wall.start.x).powi(2) + f64::from(b.y - wall.start.y).powi(2);
            da.partial_cmp(&db).unwrap_or(Ordering::Equal)
        });
        for edge in ordered.windows(2) {
            if edge[0] != edge[1] {
                graph.entry(edge[0]).or_default().push(edge[1]);
                graph.entry(edge[1]).or_default().push(edge[0]);
            }
        }
    }
    for (vertex, neighbors) in graph.iter_mut() {
        neighbors.sort_by(|a, b| {
            let aa = f64::from(a.y - vertex.y).atan2(f64::from(a.x - vertex.x));
            let bb = f64::from(b.y - vertex.y).atan2(f64::from(b.x - vertex.x));
            aa.partial_cmp(&bb).unwrap_or(Ordering::Equal)
        });
        neighbors.dedup();
    }
    graph
}

fn derive_faces(walls: &[Wall]) -> Vec<Vec<Point>> {
    let graph = split_graph(walls);
    let mut visited: HashSet<(Point, Point)> = HashSet::new();
    let mut faces = Vec::new();
    for (&start, neighbors) in &graph {
        for &next in neighbors {
            if visited.contains(&(start, next)) {
                continue;
            }
            let mut face = Vec::new();
            let (mut from, mut to) = (start, next);
            let start_edge = (from, to);
            for _ in 0..graph.len() * 4 + 4 {
                if !visited.insert((from, to)) {
                    break;
                }
                face.push(from);
                let Some(around) = graph.get(&to) else { break };
                let Some(reverse_index) = around.iter().position(|point| *point == from) else { break };
                let onward = around[(reverse_index + around.len() - 1) % around.len()];
                from = to;
                to = onward;
                if (from, to) == start_edge {
                    if face.len() >= 3 && signed_area(&face) > EPS {
                        faces.push(face);
                    }
                    break;
                }
            }
        }
    }
    faces.sort_by(|a, b| signed_area(a).partial_cmp(&signed_area(b)).unwrap_or(Ordering::Equal));
    faces
}

fn derive_rooms_internal(floor: &FloorInput) -> Vec<DerivedRoom> {
    let faces = derive_faces(&floor.walls);
    let mut rooms = Vec::new();
    for marker in &floor.room_markers {
        if let Some(face) = faces
            .iter()
            .filter(|face| contains(face, marker.position))
            .min_by(|a, b| signed_area(a).partial_cmp(&signed_area(b)).unwrap_or(Ordering::Equal))
        {
            rooms.push(DerivedRoom {
                id: marker.id.clone(),
                name: marker.name.clone(),
                polygon: face.clone(),
                area_square_metres: (signed_area(face).abs() / 1_000_000.0 * 100.0).round() / 100.0,
            });
        }
    }
    rooms.sort_by(|a, b| a.id.cmp(&b.id));
    rooms
}

fn validate_internal(floor: &FloorInput) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let mut ids = BTreeSet::new();
    for wall in &floor.walls {
        if !ids.insert(&wall.id) {
            issues.push(ValidationIssue { code: "duplicate_id".into(), severity: "error".into(), entity_id: Some(wall.id.clone()), message: "Wall IDs must be unique.".into() });
        }
        if length(wall.start, wall.end) < 100.0 {
            issues.push(ValidationIssue { code: "wall_too_short".into(), severity: "error".into(), entity_id: Some(wall.id.clone()), message: "Wall must be at least 100 mm long.".into() });
        }
        if !(60..=600).contains(&wall.thickness_mm) {
            issues.push(ValidationIssue { code: "wall_thickness".into(), severity: "error".into(), entity_id: Some(wall.id.clone()), message: "Wall thickness must be between 60 and 600 mm.".into() });
        }
    }
    for opening in &floor.openings {
        if !ids.insert(&opening.id) {
            issues.push(ValidationIssue { code: "duplicate_id".into(), severity: "error".into(), entity_id: Some(opening.id.clone()), message: "Entity IDs must be unique across the floor.".into() });
        }
        let Some(wall) = floor.walls.iter().find(|wall| wall.id == opening.wall_id) else {
            issues.push(ValidationIssue { code: "opening_wall_missing".into(), severity: "error".into(), entity_id: Some(opening.id.clone()), message: "Opening references a missing wall.".into() });
            continue;
        };
        let wall_length = length(wall.start, wall.end).round() as i32;
        if opening.offset_mm < 0 || opening.width_mm < 100 || opening.offset_mm + opening.width_mm > wall_length {
            issues.push(ValidationIssue { code: "opening_out_of_bounds".into(), severity: "error".into(), entity_id: Some(opening.id.clone()), message: "Opening must fit entirely within its wall.".into() });
        }
    }
    for marker in &floor.room_markers {
        if !ids.insert(&marker.id) {
            issues.push(ValidationIssue { code: "duplicate_id".into(), severity: "error".into(), entity_id: Some(marker.id.clone()), message: "Entity IDs must be unique across the floor.".into() });
        }
    }
    for item in &floor.furniture {
        if !ids.insert(&item.id) {
            issues.push(ValidationIssue { code: "duplicate_id".into(), severity: "error".into(), entity_id: Some(item.id.clone()), message: "Entity IDs must be unique across the floor.".into() });
        }
        if item.width_mm <= 0 || item.depth_mm <= 0 {
            issues.push(ValidationIssue { code: "furniture_size".into(), severity: "error".into(), entity_id: Some(item.id.clone()), message: "Furniture dimensions must be positive.".into() });
        }
    }
    for (index, left) in floor.openings.iter().enumerate() {
        for right in floor.openings.iter().skip(index + 1) {
            if left.wall_id == right.wall_id
                && left.offset_mm < right.offset_mm + right.width_mm
                && right.offset_mm < left.offset_mm + left.width_mm
            {
                issues.push(ValidationIssue { code: "openings_overlap".into(), severity: "error".into(), entity_id: Some(right.id.clone()), message: "Openings on the same wall cannot overlap.".into() });
            }
        }
    }
    for (index, left) in floor.furniture.iter().enumerate() {
        let left_angle = left.rotation_degrees.to_radians();
        let left_x = (f64::from(left.width_mm) * left_angle.cos().abs() + f64::from(left.depth_mm) * left_angle.sin().abs()) / 2.0;
        let left_y = (f64::from(left.width_mm) * left_angle.sin().abs() + f64::from(left.depth_mm) * left_angle.cos().abs()) / 2.0;
        for right in floor.furniture.iter().skip(index + 1) {
            let right_angle = right.rotation_degrees.to_radians();
            let right_x = (f64::from(right.width_mm) * right_angle.cos().abs() + f64::from(right.depth_mm) * right_angle.sin().abs()) / 2.0;
            let right_y = (f64::from(right.width_mm) * right_angle.sin().abs() + f64::from(right.depth_mm) * right_angle.cos().abs()) / 2.0;
            if f64::from((left.position.x - right.position.x).abs()) < left_x + right_x
                && f64::from((left.position.y - right.position.y).abs()) < left_y + right_y
            {
                issues.push(ValidationIssue { code: "furniture_collision".into(), severity: "warning".into(), entity_id: Some(right.id.clone()), message: format!("Furniture overlaps {}.", left.id) });
            }
        }
    }
    let derived = derive_rooms_internal(floor);
    for marker in &floor.room_markers {
        if !derived.iter().any(|room| room.id == marker.id) {
            issues.push(ValidationIssue { code: "room_not_enclosed".into(), severity: "error".into(), entity_id: Some(marker.id.clone()), message: "Room marker is not inside a closed wall face.".into() });
        }
    }
    issues.sort_by(|a, b| (&a.code, &a.entity_id).cmp(&(&b.code, &b.entity_id)));
    issues
}

#[wasm_bindgen]
pub fn derive_rooms(floor_json: &str) -> Result<String, JsValue> {
    let floor = parse_floor(floor_json).map_err(|error| JsValue::from_str(&error))?;
    serde_json::to_string(&derive_rooms_internal(&floor)).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn validate_floor(floor_json: &str) -> Result<String, JsValue> {
    let floor = parse_floor(floor_json).map_err(|error| JsValue::from_str(&error))?;
    serde_json::to_string(&validate_internal(&floor)).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn snap_point(floor_json: &str, x: i32, y: i32, tolerance_mm: i32) -> Result<String, JsValue> {
    let floor = parse_floor(floor_json).map_err(|error| JsValue::from_str(&error))?;
    let candidate = Point { x, y };
    let nearest = floor
        .walls
        .iter()
        .flat_map(|wall| [wall.start, wall.end])
        .filter_map(|point| {
            let distance = length(candidate, point);
            (distance <= f64::from(tolerance_mm)).then_some((point, distance))
        })
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal))
        .map(|entry| entry.0)
        .unwrap_or(candidate);
    serde_json::to_string(&nearest).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn hit_test_wall(floor_json: &str, x: i32, y: i32, tolerance_mm: i32) -> Result<String, JsValue> {
    let floor = parse_floor(floor_json).map_err(|error| JsValue::from_str(&error))?;
    let point = Point { x, y };
    let hit = floor.walls.iter().filter_map(|wall| {
        let vx = f64::from(wall.end.x - wall.start.x);
        let vy = f64::from(wall.end.y - wall.start.y);
        let wx = f64::from(point.x - wall.start.x);
        let wy = f64::from(point.y - wall.start.y);
        let denominator = vx * vx + vy * vy;
        if denominator < EPS { return None; }
        let t = ((wx * vx + wy * vy) / denominator).clamp(0.0, 1.0);
        let dx = f64::from(wall.start.x) + t * vx - f64::from(point.x);
        let dy = f64::from(wall.start.y) + t * vy - f64::from(point.y);
        let distance = (dx * dx + dy * dy).sqrt();
        (distance <= f64::from(tolerance_mm)).then_some((&wall.id, distance))
    }).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal));
    Ok(hit.map(|entry| entry.0.clone()).unwrap_or_default())
}

#[wasm_bindgen]
pub fn wall_render_vertices(floor_json: &str) -> Result<Vec<f32>, JsValue> {
    let floor = parse_floor(floor_json).map_err(|error| JsValue::from_str(&error))?;
    let mut vertices = Vec::with_capacity(floor.walls.len() * 36);
    for wall in &floor.walls {
        let dx = f64::from(wall.end.x - wall.start.x);
        let dy = f64::from(wall.end.y - wall.start.y);
        let wall_length = (dx * dx + dy * dy).sqrt();
        if wall_length < EPS { continue; }
        let half = f64::from(wall.thickness_mm) / 2.0;
        let nx = -dy / wall_length * half;
        let ny = dx / wall_length * half;
        let corners = [
            (f64::from(wall.start.x) + nx, f64::from(wall.start.y) + ny),
            (f64::from(wall.end.x) + nx, f64::from(wall.end.y) + ny),
            (f64::from(wall.end.x) - nx, f64::from(wall.end.y) - ny),
            (f64::from(wall.start.x) - nx, f64::from(wall.start.y) - ny),
        ];
        for index in [0, 1, 2, 0, 2, 3] {
            vertices.extend([corners[index].0 as f32, corners[index].1 as f32]);
        }
    }
    Ok(vertices)
}

#[wasm_bindgen]
pub fn room_render_vertices(floor_json: &str) -> Result<Vec<f32>, JsValue> {
    let floor = parse_floor(floor_json).map_err(|error| JsValue::from_str(&error))?;
    let mut vertices = Vec::new();
    for room in derive_rooms_internal(&floor) {
        for triangle in triangulate(&room.polygon) {
            for point in triangle {
                vertices.extend([point.x as f32, point.y as f32]);
            }
        }
    }
    Ok(vertices)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rectangle() -> FloorInput {
        FloorInput {
            walls: vec![
                Wall { id: "north".into(), start: Point { x: 0, y: 0 }, end: Point { x: 6000, y: 0 }, thickness_mm: 150 },
                Wall { id: "east".into(), start: Point { x: 6000, y: 0 }, end: Point { x: 6000, y: 4000 }, thickness_mm: 150 },
                Wall { id: "south".into(), start: Point { x: 6000, y: 4000 }, end: Point { x: 0, y: 4000 }, thickness_mm: 150 },
                Wall { id: "west".into(), start: Point { x: 0, y: 4000 }, end: Point { x: 0, y: 0 }, thickness_mm: 150 },
            ],
            openings: vec![],
            room_markers: vec![RoomMarker { id: "living".into(), name: "Living".into(), position: Point { x: 2000, y: 2000 } }],
            furniture: vec![],
        }
    }

    #[test]
    fn intersection_splits_shared_walls() {
        let mut floor = rectangle();
        floor.walls.push(Wall { id: "shared".into(), start: Point { x: 3000, y: 0 }, end: Point { x: 3000, y: 4000 }, thickness_mm: 100 });
        let graph = split_graph(&floor.walls);
        assert!(graph.contains_key(&Point { x: 3000, y: 0 }));
        assert!(graph.contains_key(&Point { x: 3000, y: 4000 }));
        assert_eq!(derive_faces(&floor.walls).len(), 2);
    }

    #[test]
    fn collinear_shared_wall_endpoints_split_the_graph() {
        let walls = vec![
            Wall { id: "long".into(), start: Point { x: 0, y: 0 }, end: Point { x: 6000, y: 0 }, thickness_mm: 100 },
            Wall { id: "shared".into(), start: Point { x: 3000, y: 0 }, end: Point { x: 6000, y: 0 }, thickness_mm: 100 },
        ];
        let graph = split_graph(&walls);
        assert!(graph.contains_key(&Point { x: 3000, y: 0 }));
    }

    #[test]
    fn derives_seeded_face_and_area() {
        let rooms = derive_rooms_internal(&rectangle());
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0].area_square_metres, 24.0);
        assert!(contains(&rooms[0].polygon, Point { x: 100, y: 100 }));
    }

    #[test]
    fn detects_invalid_topology_and_opening_bounds() {
        let mut floor = rectangle();
        floor.walls.pop();
        floor.openings.push(Opening { id: "door".into(), wall_id: "north".into(), kind: "door".into(), offset_mm: 5900, width_mm: 900 });
        let issues = validate_internal(&floor);
        assert!(issues.iter().any(|issue| issue.code == "room_not_enclosed"));
        assert!(issues.iter().any(|issue| issue.code == "opening_out_of_bounds"));
    }

    #[test]
    fn rejects_overlapping_openings() {
        let mut floor = rectangle();
        floor.openings = vec![
            Opening { id: "a".into(), wall_id: "north".into(), kind: "door".into(), offset_mm: 500, width_mm: 1000 },
            Opening { id: "b".into(), wall_id: "north".into(), kind: "window".into(), offset_mm: 1200, width_mm: 1000 },
        ];
        assert!(validate_internal(&floor).iter().any(|issue| issue.code == "openings_overlap"));
    }

    #[test]
    fn snapping_and_hit_testing_are_deterministic() {
        let floor = rectangle();
        let json = serde_json::to_string(&floor).unwrap();
        assert_eq!(snap_point(&json, 20, 15, 100).unwrap(), r#"{"x":0,"y":0}"#);
        assert_eq!(hit_test_wall(&json, 3000, 25, 100).unwrap(), "north");
        assert_eq!(wall_render_vertices(&json).unwrap().len(), 48);
        assert_eq!(wall_render_vertices(&json).unwrap(), wall_render_vertices(&json).unwrap());
        assert_eq!(room_render_vertices(&json).unwrap().len(), 12);
    }

    #[test]
    fn reports_furniture_collisions_as_actionable_warnings() {
        let mut floor = rectangle();
        floor.furniture = vec![
            Furniture { id: "sofa".into(), position: Point { x: 2000, y: 2000 }, width_mm: 2000, depth_mm: 900, rotation_degrees: 0.0 },
            Furniture { id: "table".into(), position: Point { x: 2300, y: 2000 }, width_mm: 900, depth_mm: 900, rotation_degrees: 45.0 },
        ];
        assert!(validate_internal(&floor).iter().any(|issue| issue.code == "furniture_collision" && issue.severity == "warning"));
    }

    #[test]
    fn rejects_duplicate_ids_across_entity_kinds() {
        let mut floor = rectangle();
        floor.openings.push(Opening { id: "north".into(), wall_id: "north".into(), kind: "door".into(), offset_mm: 500, width_mm: 900 });
        assert!(validate_internal(&floor).iter().any(|issue| issue.code == "duplicate_id" && issue.entity_id.as_deref() == Some("north")));
    }

    #[test]
    fn triangulates_concave_rooms_without_changing_area() {
        let polygon = vec![Point { x: 0, y: 0 }, Point { x: 4000, y: 0 }, Point { x: 4000, y: 2000 }, Point { x: 2000, y: 2000 }, Point { x: 2000, y: 4000 }, Point { x: 0, y: 4000 }];
        let triangles = triangulate(&polygon);
        let area: f64 = triangles.iter().map(|triangle| signed_area(triangle).abs()).sum();
        assert_eq!(triangles.len(), polygon.len() - 2);
        assert!((area - signed_area(&polygon).abs()).abs() < EPS);
    }
}
