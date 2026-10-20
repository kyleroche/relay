# /// script
# dependencies = []
#
# [tool.griptape-nodes]
# name = "relay-echo"
# schema_version = "0.11.0"
# engine_version_created_with = "0.62.2"
# node_libraries_referenced = [["Griptape Nodes Library", "0.50.0"]]
# node_types_used = [["Griptape Nodes Library", "EndFlow"], ["Griptape Nodes Library", "StartFlow"]]
# is_griptape_provided = false
# is_template = false
# description = "relay's test workflow: Start Flow's `topic` flows straight into End Flow's `greeting`. No model, no key, no network."
#
# ///

# A Griptape Nodes workflow file in the engine's own saved format, reduced to the two workflow nodes. The nodes lane's
# shim (packages/cli/python/run_workflow.py) loads it through the engine and reads End Flow's parameters back; the
# test checks the JSON contract without spending a cent on a model.

from griptape_nodes.retained_mode.events.connection_events import CreateConnectionRequest
from griptape_nodes.retained_mode.events.flow_events import CreateFlowRequest
from griptape_nodes.retained_mode.events.library_events import GetAllInfoForAllLibrariesRequest, GetAllInfoForAllLibrariesResultSuccess, ReloadAllLibrariesRequest
from griptape_nodes.retained_mode.events.node_events import CreateNodeRequest
from griptape_nodes.retained_mode.events.parameter_events import AddParameterToNodeRequest
from griptape_nodes.retained_mode.griptape_nodes import GriptapeNodes

response = GriptapeNodes.LibraryManager().get_all_info_for_all_libraries_request(GetAllInfoForAllLibrariesRequest())

if isinstance(response, GetAllInfoForAllLibrariesResultSuccess) and len(response.library_name_to_library_info.keys()) < 1:
    GriptapeNodes.handle_request(ReloadAllLibrariesRequest())

context_manager = GriptapeNodes.ContextManager()

if not context_manager.has_current_workflow():
    context_manager.push_workflow(workflow_name="relay-echo")

flow0_name = GriptapeNodes.handle_request(CreateFlowRequest(parent_flow_name=None, set_as_new_context=False, metadata={})).flow_name

with GriptapeNodes.ContextManager().flow(flow0_name):
    start_name = GriptapeNodes.handle_request(
        CreateNodeRequest(
            node_type="StartFlow",
            specific_library_name="Griptape Nodes Library",
            node_name="Start Flow",
            metadata={"position": {"x": 0, "y": 0}, "library": "Griptape Nodes Library", "node_type": "StartFlow", "showaddparameter": True, "category": "workflows"},
            resolution="resolved",
            initial_setup=True,
        )
    ).node_name
    with GriptapeNodes.ContextManager().node(start_name):
        GriptapeNodes.handle_request(
            AddParameterToNodeRequest(
                parameter_name="topic",
                default_value="",
                tooltip="What to echo",
                type="str",
                input_types=["str"],
                output_type="str",
                ui_options={"is_custom": True, "is_user_added": True},
                mode_allowed_input=True,
                mode_allowed_property=True,
                mode_allowed_output=True,
                parent_container_name="",
                initial_setup=True,
            )
        )
    end_name = GriptapeNodes.handle_request(
        CreateNodeRequest(
            node_type="EndFlow",
            specific_library_name="Griptape Nodes Library",
            node_name="End Flow",
            metadata={"position": {"x": 800, "y": 0}, "library": "Griptape Nodes Library", "node_type": "EndFlow", "showaddparameter": True, "category": "workflows"},
            initial_setup=True,
        )
    ).node_name
    with GriptapeNodes.ContextManager().node(end_name):
        GriptapeNodes.handle_request(
            AddParameterToNodeRequest(
                parameter_name="greeting",
                default_value="",
                tooltip="The echoed topic",
                type="str",
                input_types=["str"],
                output_type="str",
                ui_options={"is_custom": True, "is_user_added": True},
                mode_allowed_input=True,
                mode_allowed_property=True,
                mode_allowed_output=True,
                parent_container_name="",
                initial_setup=True,
            )
        )
    GriptapeNodes.handle_request(CreateConnectionRequest(source_node_name=start_name, source_parameter_name="exec_out", target_node_name=end_name, target_parameter_name="exec_in", initial_setup=True))
    GriptapeNodes.handle_request(CreateConnectionRequest(source_node_name=start_name, source_parameter_name="topic", target_node_name=end_name, target_parameter_name="greeting", initial_setup=True))
