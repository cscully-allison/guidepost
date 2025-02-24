import anywidget
import traitlets
import pandas as pd
import json
import os

class Guidepost(anywidget.AnyWidget):
    _esm = os.path.join(os.path.dirname(__file__), "guidepost.js")
    vis_data = traitlets.Dict({}).tag(sync=True)
    vis_configs = traitlets.Dict({
        'x': 'submit_time',
        'y': 'queue_wait',
        'color': 'nodes_req',
        'color_agg': 'avg',
        'categorical': 'user'}).tag(sync=True)
    selected_records = traitlets.Unicode("[]").tag(sync=True)
    records_df = pd.DataFrame()

    def retrieve_selected_data(self):
        obj = json.loads(self.selected_records)
        self.records_df = pd.DataFrame()
        
        for val in obj:
            self.records_df = pd.concat([self.records_df, pd.DataFrame.from_records(obj[val])])
            
        return self.records_df