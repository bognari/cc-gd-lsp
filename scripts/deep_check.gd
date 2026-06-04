@tool
extends SceneTree

# Loads every .tscn/.tres under res:// so Godot prints load/instantiation errors
# to stderr (with res://file:line), then prints a sentinel so the caller knows the
# run completed. Invoked as:
#   godot --headless --path <project> --script res://<this-file>
# The Node-side runner copies this file into the project before invoking.

func _init() -> void:
	var paths := _scan("res://")
	for p in paths:
		var res := ResourceLoader.load(p, "", ResourceLoader.CACHE_MODE_IGNORE)
		if res == null:
			printerr("GDRESLSP_LOADFAIL\t%s" % p)
	print("GDRESLSP_DONE")
	quit()

func _scan(dir_path: String) -> Array:
	var out: Array = []
	var d := DirAccess.open(dir_path)
	if d == null:
		return out
	d.list_dir_begin()
	var n := d.get_next()
	while n != "":
		if n == ".godot" or n == ".import" or n == "node_modules" or n.begins_with("."):
			n = d.get_next()
			continue
		var full := dir_path.path_join(n)
		if d.current_is_dir():
			out.append_array(_scan(full))
		elif n.ends_with(".tscn") or n.ends_with(".tres"):
			out.append(full)
		n = d.get_next()
	d.list_dir_end()
	return out
