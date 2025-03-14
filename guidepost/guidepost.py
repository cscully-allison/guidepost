import anywidget
import traitlets
import pandas as pd
import numpy as np
import warnings
import json
import os

class Guidepost(anywidget.AnyWidget):
    _esm = os.path.join("../guidepost/guidepost.js")
    vis_data = traitlets.Dict({}).tag(sync=True)
    vis_configs = traitlets.Dict({}).tag(sync=True)
    selected_records = traitlets.Unicode("[]").tag(sync=True)
    cached_records_df = None
    records_df = pd.DataFrame()
    
    def load_data(self, in_df, supress_warnings=False):
        '''
            Load dataframe in a safe way.
            Drop NAs, remove time deltas, report warnings
        '''

        in_df.insert(0, 'gp_idx', range(0, len(in_df)))
        self.cached_records_df = in_df

        _warn_skips = (os.path.dirname('.'),)
        original_cols = in_df.columns
        o_df = in_df.dropna(axis=1, how='all')
        
        #remove columns with only nans
        col_diff = original_cols.difference(o_df.columns)
        if(len(col_diff)>0):
            rmvd_cols = ', '.join(col_diff)
            if(not supress_warnings):
                warnings.warn("The following columns were dropped because they contained entirely 'na' values which guidepost does not support:[{}]".format(rmvd_cols), skip_file_prefixes=_warn_skips)
            original_cols = o_df.columns
            
        # drop rows where nans are present
        row_count = o_df.shape[0]
        o_df = o_df.dropna()
        row_diff = row_count-o_df.shape[0]
        if(row_diff>0):
            rmvd_cols = ', '.join(col_diff)
            if(not supress_warnings):
                warnings.warn("Some rows were dropped because at least one column contained 'na' values which guidepost does not support.", skip_file_prefixes=_warn_skips)
            original_cols = o_df.columns
        
        #drop columns which are timedelta type
        o_df = o_df.select_dtypes(exclude=['timedelta64[ns]'])
        col_diff = original_cols.difference(o_df.columns)
        if(len(col_diff)>0):
            rmvd_cols = ', '.join(col_diff)
            if(not supress_warnings):
                warnings.warn("The following columns were dropped because they contained 'timedelta' values which guidepost does not support:[{}]".format(rmvd_cols), skip_file_prefixes=_warn_skips)
            original_cols = o_df.columns
        
        #drop arrays/complex datatypes
        col_diff = []
        for col in o_df.columns:
            if(type(o_df[col].iloc[0]) == type(np.ndarray([]))):
                col_diff.append(col)
                o_df = o_df.drop(col, axis=1)
                
        if(len(col_diff)>0):
            rmvd_cols = ', '.join(col_diff)
            if(not supress_warnings):
                warnings.warn("The following columns were dropped because they contained array values in cells which guidepost does not support:[{}]".format(rmvd_cols), skip_file_prefixes=_warn_skips)
            original_cols = o_df.columns
            
              
        #add synthetic index
        if(o_df.shape[0]>250_000):
            if(not supress_warnings):
                warnings.warn("Your dataframe is very large. You may experience performance issues. Consider subsampling or reducing the data down to below 200,000 rows to enhance performance.".format(rmvd_cols), skip_file_prefixes=_warn_skips)

        
        self.vis_data = o_df.to_dict()
        
        
    def retrieve_selected_data(self):
        selected_records_idx = json.loads(self.selected_records)
        
        self.records_df = self.cached_records_df[self.cached_records_df['gp_idx'].isin(selected_records_idx)]
        
        #remove synthetic index
        return self.records_df.drop('gp_idx', axis=1)