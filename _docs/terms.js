function init() {
  AKDATA.load([
    'excel/gamedata_const.json',
  ], load);
}

function load() {
  let selector = {};
  let body = [];

  let list = pmBase.component.create({
    type: 'list',
    columns: [ {header:'术语',width:'20%'}, '效果说明', 'ID' ],
    list: Object.values(AKDATA.Data.gamedata_const.termDescriptionDict).orderby(x=>x.termId).map( itemData=> [
      itemData.termName,
      AKDATA.formatString(itemData.description,true),
      itemData.termId
    ]),
    sortable: true,
    card:true,
  });

	pmBase.content.build({
	  pages: [{
      content: list,
    }]
	});
}

pmBase.hook.on( 'init', init );